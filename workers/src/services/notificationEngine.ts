/**
 * Notification engine — evaluates rules and dispatches plan comparison alerts.
 *
 * Triggered by Queue (flip-notify-queue) after a comparison finds meaningful savings.
 * Respects frequency limits (max 1/month unless material change),
 * generates messages via DeepSeek orchestration, and sends via Sent.
 */

import { getLatestComparisonForUser, getComparisonsByUserId } from '../models/comparisons';
import { getPlanById } from '../models/plans';
import { getRetailerById } from '../models/retailers';
import { getBillsByUserId } from '../models/bills';
import { getUserById, getNotificationThreshold } from '../models/users';
import { sendText } from './messaging';
import { explainComparison as _explainComparison, generateStayPutMessage, generateSavingMessage } from './comparisonIntelligence';
import type { Recommendation } from '../types/comparison';

interface NotifyEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly SENT_API_KEY: string;
  readonly ENCRYPTION_KEY: string;
  readonly DEEPSEEK_API_KEY?: string;
}

/**
 * Issue #126 — pure threshold predicate. Inclusive at the boundary:
 * a saving equal to the threshold qualifies (notify). Below does not.
 *
 * savingCents follows the Python comparison convention: positive = saving.
 * Both arguments are in integer cents NZD.
 */
export function meetsThreshold(savingCents: number, thresholdCents: number): boolean {
  return savingCents >= thresholdCents;
}

// Legacy default retained for reference / cooldown material-change calc.
// Per-user threshold is read via getNotificationThreshold (issue #126).
const NOTIFY_COOLDOWN_DAYS = 30;
const NOTIFY_COOLDOWN_KEY_PREFIX = 'notify_cooldown:';
const MATERIAL_CHANGE_THRESHOLD_PCT = 20; // notify if saving changes by >20%

// Issue #128 — send-side dedup. A THIRD guard, distinct from the enqueue-side
// `notified:{comparisonId}` (#74, 30d) and the per-user `notify_cooldown:`
// (#74, 30d). This one fires at the dispatch moment and drops a second send
// of the SAME plan recommendation to the SAME user within 1h.
const SEND_DEDUP_KEY_PREFIX = 'dedup:';
const SEND_DEDUP_TTL_SECONDS = 60 * 60; // 1 hour

// Issue #127 — per-user+plan cooldown. A FOURTH guard, distinct from the three
// above. Supersedes a second notification of the SAME user about the SAME best
// plan within 7 days (PRD 3.4). Keying on planId means a plan change clears the
// cooldown automatically (different plan -> different key -> absent).
const COOLDOWN_KEY_PREFIX = 'cooldown:';
const COOLDOWN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Issue #128 — build the send-side dedup KV key for a (user, plan) pair.
 * Pure helper; tested directly. planId may be empty for stay_put verdicts
 * (no best plan), in which case the key still partitions per-user.
 */
export function buildSendDedupKey(userId: string, planId: string): string {
  return `${SEND_DEDUP_KEY_PREFIX}${userId}:${planId}`;
}

/**
 * Issue #128 — pure predicate: given the KV-exists result, decide whether
 * the send falls inside the 1h dedup window and must be skipped.
 */
export function isWithinSendDedupWindow(dedupKeyExists: boolean): boolean {
  return dedupKeyExists;
}

/**
 * Issue #127 — build the per-user+plan cooldown KV key. Pure helper; tested
 * directly. Mirrors `buildSendDedupKey` but lives in its own namespace so the
 * 7d cooldown and the 1h dedup compose without colliding.
 */
export function buildCooldownKey(userId: string, planId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${userId}:${planId}`;
}

/**
 * Issue #127 — pure predicate: given the KV-exists result, decide whether the
 * dispatch falls inside the 7d per-user+plan cooldown and must be skipped.
 */
export function isWithinCooldownWindow(cooldownKeyExists: boolean): boolean {
  return cooldownKeyExists;
}

function savingToDollars(cents: number): number {
  return Math.round(Math.abs(cents) / 100);
}

/**
 * Evaluate notification rules and send alert if appropriate.
 *
 * AC #74 — the NOTIFY_QUEUE payload now also carries billId and recommendation.
 * They are accepted here for traceability/forward use but are not load-bearing:
 * this consumer re-fetches the comparison by comparisonId and derives verdict
 * (switch/stay_put) from the persisted savingCents, so omitting them (e.g. from
 * an older enqueued message) is safe.
 */
export async function evaluateAndNotify(
  userId: string,
  comparisonId: string,
  env: NotifyEnv,
  billId?: string,
  recommendation?: Recommendation
): Promise<void> {
  // Trace log links the queue payload to this evaluation (AC #74 traceability).
  console.log(JSON.stringify({
    type: 'notify_evaluate',
    userId,
    comparisonId,
    billId: billId ?? null,
    recommendation: recommendation ?? null,
    timestamp: new Date().toISOString(),
  }));
  // 1. Fetch the comparison result
  const comparison = await getLatestComparisonForUser(env.DB, userId);
  if (!comparison || comparison.id !== comparisonId) {
    console.log(JSON.stringify({
      type: 'notify_skip',
      userId,
      reason: 'comparison not found or not latest',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // 2. Check if saving meets the user's configured threshold (issue #126).
  //    Default 5000 cents ($50) when the user/column is unset.
  const thresholdCents = await getNotificationThreshold(
    env.DB,
    { ENCRYPTION_KEY: env.ENCRYPTION_KEY },
    userId
  );
  if (!meetsThreshold(comparison.savingCents, thresholdCents)) {
    console.log(JSON.stringify({
      type: 'notify_skip',
      userId,
      reason: 'saving below threshold',
      savingCents: comparison.savingCents,
      thresholdCents,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // 3. Check frequency cooldown
  const cooldownKey = `${NOTIFY_COOLDOWN_KEY_PREFIX}${userId}`;
  const lastNotified = await env.KV.get(cooldownKey);
  if (lastNotified) {
    const lastDate = new Date(lastNotified);
    const daysSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < NOTIFY_COOLDOWN_DAYS) {
      // Check if this is a materially different saving
      const previousComparisons = await getComparisonsByUserId(env.DB, userId, 2);
      const previous = previousComparisons.find(c => c.id !== comparisonId);
      if (previous) {
        const changePct = Math.abs(comparison.savingCents - previous.savingCents) /
          Math.max(1, Math.abs(previous.savingCents)) * 100;
        if (changePct < MATERIAL_CHANGE_THRESHOLD_PCT) {
          console.log(JSON.stringify({
            type: 'notify_skip',
            userId,
            reason: 'cooldown active, no material change',
            daysSinceLast: Math.round(daysSince),
            changePct: Math.round(changePct),
            timestamp: new Date().toISOString(),
          }));
          return;
        }
      }
    }
  }

  // 4. Get user phone
  const user = await getUserById(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, userId);
  const phone = user?.phone ?? null;
  if (!phone) {
    console.log(JSON.stringify({
      type: 'notify_skip',
      userId,
      reason: 'no phone number for user',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // 5. Fetch real plan, retailer, and bill data for notification context
  let bestPlanName = 'alternative plan';
  let bestRetailerName = '';
  let currentPlanName: string | null = 'your current plan';

  if (comparison.planId) {
    const bestPlan = await getPlanById(env.DB, comparison.planId);
    if (bestPlan) {
      bestPlanName = bestPlan.name;
      const retailer = await getRetailerById(env.DB, bestPlan.retailerId);
      if (retailer) {
        bestRetailerName = retailer.name;
      }
    }
  }

  const allBills = await getBillsByUserId(env.DB, userId);
  const parsedBills = allBills.filter(b => b.status === 'parsed');
  if (parsedBills.length > 0) {
    currentPlanName = parsedBills[0]!.planName ?? 'your current plan';
  }

  const savingDollars = savingToDollars(comparison.savingCents);
  const isStayPut = comparison.savingCents <= 0;

  const ctx = {
    bestPlanName,
    bestRetailerName,
    savingDollarsPerYear: savingDollars,
    currentPlanName,
    currentAnnualCostDollars: Math.round(comparison.currentCostCents / 100),
    stayWhereYouAre: isStayPut,
    confidence: comparison.confidence,
    billCount: Math.max(1, parsedBills.length),
  };

  let message: string;
  if (isStayPut) {
    message = await generateStayPutMessage(ctx, env.DEEPSEEK_API_KEY);
  } else {
    message = await generateSavingMessage(ctx, env.DEEPSEEK_API_KEY);
  }

  // Issue #128 — send-side dedup. Checked immediately before dispatch so a
  // second evaluation of the SAME (user, plan) within 1h is dropped even if
  // it slipped past the enqueue-side `notified:` guard (e.g. distinct
  // comparisonId, same recommendation). The key never contains PII — only
  // opaque ids.
  const sendDedupKey = buildSendDedupKey(userId, comparison.planId ?? '');
  if (isWithinSendDedupWindow((await env.KV.get(sendDedupKey)) !== null)) {
    console.log(JSON.stringify({
      type: 'notify_skip',
      userId,
      reason: 'send dedup window active (1h, same user+plan)',
      planId: comparison.planId ?? null,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Issue #127 — per-user+plan 7d cooldown. Distinct from the 1h dedup above:
  // the 1h guard suppresses burst re-evaluations; this suppresses re-notifying
  // the same user about the same best plan for a week. Keyed on planId so a
  // plan change clears it automatically (AC: "cleared automatically on plan
  // change"). Weekends and NZ public holidays are included — it is a flat 7d
  // TTL, not a business-day calc.
  const planCooldownKey = buildCooldownKey(userId, comparison.planId ?? '');
  if (isWithinCooldownWindow((await env.KV.get(planCooldownKey)) !== null)) {
    console.log(JSON.stringify({
      type: 'notify_skip',
      userId,
      reason: 'cooldown window active (7d, same user+plan)',
      planId: comparison.planId ?? null,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  try {
    await sendText(env.SENT_API_KEY, phone, message);
  } catch (error) {
    console.log(JSON.stringify({
      type: 'notify_send_error',
      userId,
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
    return; // don't update cooldown if send failed
  }

  // Issue #128 — mark this (user, plan) as sent for the 1h window. Set only
  // after a successful dispatch so a failed send can be retried immediately.
  await env.KV.put(sendDedupKey, new Date().toISOString(), {
    expirationTtl: SEND_DEDUP_TTL_SECONDS,
  });

  // Issue #127 — mark this (user, plan) as notified for the 7d cooldown. Set
  // only after a successful dispatch; cleared automatically on plan change.
  await env.KV.put(planCooldownKey, new Date().toISOString(), {
    expirationTtl: COOLDOWN_TTL_SECONDS,
  });

  // 6. Update cooldown
  await env.KV.put(cooldownKey, new Date().toISOString(), {
    expirationTtl: NOTIFY_COOLDOWN_DAYS * 24 * 60 * 60,
  });

  console.log(JSON.stringify({
    type: 'notify_sent',
    userId,
    comparisonId,
    savingCents: comparison.savingCents,
    isStayPut,
    timestamp: new Date().toISOString(),
  }));
}
