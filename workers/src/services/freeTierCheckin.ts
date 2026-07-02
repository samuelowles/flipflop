/**
 * Issue #78 (Epic #8) — free-tier monthly check-in.
 *
 * Monthly cron sends each active free-tier user one `free_tier_checkin`
 * notification summarising their current plan status, WITHOUT always-on
 * monitoring. The status is one of four PRD variants:
 *
 *   - `wait_until_date`     — user is in a fixed-term contract that has not
 *                              expired; switching now would incur a break fee.
 *                              (Checked first — highest priority.)
 *   - `likely_better_plan`  — latest comparison recommends switching and the
 *                              saving clears the user's threshold.
 *   - `not_worth_it`        — a saving exists but is below the user's
 *                              threshold (marginal), OR the comparison said
 *                              stay_put for cost reasons (low_savings /
 *                              no_savings).
 *   - `still_fine`          — no better plan, recommendation stay_put for a
 *                              non-cost reason, or no recent comparison.
 *
 * Dedup: a per-user KV gate (`free_tier_checkin:{userId}`) with a ~28-day TTL
 * ensures a re-run within the month does not double-send (the cron is daily-
 * slot-guarded, but KV protects against manual re-invocation + cron drift).
 *
 * Send path: dedicated small sender (NOT the NOTIFY_QUEUE / evaluateAndNotify
 * path, which is gated on a comparisonId + saving threshold that do not apply
 * to a status check-in). Reuses renderTemplate + sendText + createNotificationAudit
 * so the compliance audit row is still written. The free_tier_checkin template
 * (sentTemplates.ts) carries a single `status_summary` variable.
 */

import { getFreeTierUsers, getUserById, getNotificationThreshold } from '../models/users';
import type { EncryptionEnv } from '../models/encryption';
import { getLatestComparisonForUser } from '../models/comparisons';
import { getLatestFixedTermForUser } from '../models/bills';
import { sendText } from './messaging';
import { renderTemplate } from './sentTemplates';
import { createNotificationAudit } from '../models/notificationAudit';
import type { PlanComparison, RecommendationReason } from '../types/comparison';

/** The four PRD status variants a check-in can report (AC #78). */
export type CheckinVariant =
  | 'still_fine'
  | 'likely_better_plan'
  | 'not_worth_it'
  | 'wait_until_date';

/** KV dedup gate — ~28 day TTL (covers a monthly cadence with cron drift). */
const DEDUP_KEY_PREFIX = 'free_tier_checkin:';
const DEDUP_TTL_SECONDS = 28 * 24 * 60 * 60;

export interface FreeTierCheckinEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly SENT_API_KEY: string;
  readonly ENCRYPTION_KEY: string;
}

/**
 * Input to the PURE classifier — everything the variant decision needs,
 * with no D1/KV/Sent handles so it is trivially unit-testable.
 */
export interface CheckinContext {
  /** ISO date of the user's latest fixed-term expiry, or null if none. */
  readonly fixedTermExpiry: string | null;
  /** Latest comparison verdict, or null when no comparison exists yet. */
  readonly latestComparison: PlanComparison | null;
  /** The user's configured saving threshold in integer cents NZD. */
  readonly thresholdCents: number;
  /** "Now" — injected so tests can freeze time. */
  readonly now: Date;
}

/** Reasons that mark a stay_put verdict as cost-driven (marginal saving). */
const COST_STAY_PUT_REASONS: ReadonlySet<RecommendationReason> = new Set([
  'no_savings',
  'low_savings',
]);

/**
 * PURE classification function. Maps a user's latest state to one of the four
 * PRD check-in variants. Priority order (AC #78):
 *
 *   1. wait_until_date    — fixed-term contract still in force.
 *   2. likely_better_plan — recommendation switch + saving clears threshold.
 *   3. not_worth_it       — saving below threshold, or stay_put for cost.
 *   4. still_fine         — no comparison / stay_put for non-cost reasons.
 *
 * `savingCents` follows the Python comparator convention (positive = saving),
 * consistent with notificationEngine.meetsThreshold.
 */
export function classifyCheckin(ctx: CheckinContext): CheckinVariant {
  // 1. Fixed-term contract not yet expired — do not switch now.
  if (ctx.fixedTermExpiry) {
    if (ctx.fixedTermExpiry > ctx.now.toISOString()) {
      return 'wait_until_date';
    }
  }

  const comp = ctx.latestComparison;
  if (comp) {
    const savingCents = comp.savingCents;
    const clearsThreshold = savingCents >= ctx.thresholdCents;

    // 2. Switch recommended and saving clears the threshold.
    if (comp.recommendation === 'switch' && clearsThreshold && savingCents > 0) {
      return 'likely_better_plan';
    }

    // 3. Marginal saving (below threshold) OR stay_put for cost reasons.
    const isCostStayPut =
      comp.recommendation === 'stay_put' &&
      (comp.reason !== undefined && comp.reason !== null
        ? COST_STAY_PUT_REASONS.has(comp.reason)
        : false);
    const marginalSaving = savingCents > 0 && !clearsThreshold;
    if (marginalSaving || isCostStayPut) {
      return 'not_worth_it';
    }
  }

  // 4. No comparison, or stay_put for a non-cost reason (e.g. contract lock-in
  //    already surfaced via fixed_term, or recent_switch).
  return 'still_fine';
}

/**
 * Build the human-readable status_summary string for the free_tier_checkin
 * template's single variable. PURE (no I/O). Kept separate from the classifier
 * so the classifier stays a pure enum decision.
 */
export function buildStatusSummary(
  variant: CheckinVariant,
  ctx: CheckinContext
): string {
  switch (variant) {
    case 'wait_until_date':
      // fixedTermExpiry is non-null whenever the variant is wait_until_date.
      return `Your current plan is locked in until ${ctx.fixedTermExpiry?.slice(0, 10)}` +
        ` — we'll check again closer to then.`;
    case 'likely_better_plan': {
      const dollars = Math.round(Math.abs(ctx.latestComparison?.savingCents ?? 0) / 100);
      return `You could save around $${dollars}/yr by switching plans.`;
    }
    case 'not_worth_it':
      return `We checked the market — your current plan is still competitive. ` +
        `No switch worth it right now.`;
    case 'still_fine':
      return `You're on a good plan — nothing to action this month.`;
  }
}

/**
 * Monthly free-tier check-in run. Iterates free-tier users, classifies each
 * into a variant, dedups via KV, and sends the free_tier_checkin notification.
 *
 * Returns a summary for observability. Emits ZERO PII to logs (only counts).
 */
export async function runFreeTierCheckin(env: FreeTierCheckinEnv): Promise<{
  usersChecked: number;
  notificationsSent: number;
  skippedDedup: number;
  skippedNoPhone: number;
  failed: number;
}> {
  const userIds = await getFreeTierUsers(env.DB);
  const now = new Date();
  const encEnv: EncryptionEnv = { ENCRYPTION_KEY: env.ENCRYPTION_KEY };

  let notificationsSent = 0;
  let skippedDedup = 0;
  let skippedNoPhone = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      // Dedup gate — KV-first so a re-run within the month is a no-op.
      const dedupKey = `${DEDUP_KEY_PREFIX}${userId}`;
      if ((await env.KV.get(dedupKey)) !== null) {
        skippedDedup++;
        continue;
      }

      // Gather per-user context.
      const thresholdCents = await getNotificationThreshold(env.DB, encEnv, userId);
      const [user, latestComparison, fixedTermExpiry] = await Promise.all([
        getUserById(env.DB, encEnv, userId),
        getLatestComparisonForUser(env.DB, userId),
        getLatestFixedTermForUser(env.DB, userId),
      ]);

      if (!user || !user.phone) {
        skippedNoPhone++;
        continue;
      }

      const ctx: CheckinContext = {
        fixedTermExpiry,
        latestComparison,
        thresholdCents,
        now,
      };
      const variant = classifyCheckin(ctx);
      const statusSummary = buildStatusSummary(variant, ctx);

      const message = renderTemplate('free_tier_checkin', {
        status_summary: statusSummary,
      });

      let sentMessageId: string | null = null;
      try {
        const result = await sendText(env.SENT_API_KEY, user.phone, message);
        sentMessageId = result.messageId;
      } catch (error) {
        failed++;
        const reason = error instanceof Error ? error.message : 'unknown';
        console.log(JSON.stringify({
          type: 'free_tier_checkin_send_error',
          userId,
          variant,
          error: reason,
          timestamp: now.toISOString(),
        }));
        // ponytail: record the failure in the compliance audit; do NOT set the
        // dedup key so the next tick can retry this user.
        void createNotificationAudit(env.DB, {
          userId,
          notificationType: 'free_tier_checkin',
          channel: 'whatsapp',
          template: 'free_tier_checkin',
          status: 'failed',
          reason,
        });
        continue;
      }

      // Mark sent — set the dedup gate AFTER successful dispatch.
      await env.KV.put(dedupKey, now.toISOString(), {
        expirationTtl: DEDUP_TTL_SECONDS,
      });

      // Compliance audit row (mirrors notificationEngine.send path).
      void createNotificationAudit(env.DB, {
        userId,
        notificationType: 'free_tier_checkin',
        channel: 'whatsapp',
        template: 'free_tier_checkin',
        sentMessageId,
        status: 'sent',
      });

      notificationsSent++;
      console.log(JSON.stringify({
        type: 'free_tier_checkin_sent',
        userId,
        variant,
        timestamp: now.toISOString(),
      }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({
        type: 'free_tier_checkin_user_error',
        userId,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: now.toISOString(),
      }));
    }
  }

  console.log(JSON.stringify({
    type: 'free_tier_checkin_run',
    users_checked: userIds.length,
    notifications_sent: notificationsSent,
    skipped_dedup: skippedDedup,
    skipped_no_phone: skippedNoPhone,
    failed,
    timestamp: now.toISOString(),
  }));

  return {
    usersChecked: userIds.length,
    notificationsSent,
    skippedDedup,
    skippedNoPhone,
    failed,
  };
}
