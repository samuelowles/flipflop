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
