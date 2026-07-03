/**
 * Issue #81 (Epic #8) — switch_update user notifications + daily sanity cron.
 *
 * Two responsibilities, kept together because they are the two halves of #81:
 *
 *   1. `notifySwitchUpdate` — render + send the `switch_update` WhatsApp
 *      template (PRD 7.7) to the user at each notifiable milestone, via the
 *      DEDICATED-sender pattern (renderTemplate + sendText +
 *      createNotificationAudit). Does NOT route through notificationEngine's
 *      evaluateAndNotify (that path is comparison-gated; switch updates are
 *      state-machine events, not comparison outcomes). Reuses the #78/#79
 *      dedicated-sender shape so the compliance audit row is still written.
 *
 *   2. `runSwitchSanityCheck` — daily cron that scans for switches stuck
 *      `in_progress` past a threshold (no retailer webhook confirmation) and
 *      marks them failed via `failSwitch` — wiring the deferred LIVE TRIGGER
 *      for #132's ops-email path. This is the first real failSwitch caller.
 *
 * NOTIFIABLE MILESTONES (AC #81 names SUBMITTED/ACCEPTED/ACTIVE/FAILED):
 *   requested (SUBMITTED), confirmed (ACCEPTED), completed (ACTIVE), failed.
 * `in_progress` is skipped — noisy intermediate, not named in the AC.
 */

import type { Switch, SwitchStatus } from '../types/switch';
import { getUserById } from '../models/users';
import { getRetailerById } from '../models/retailers';
import { getPlanById } from '../models/plans';
import { getStuckSwitches } from '../models/switches';
import type { EncryptionEnv } from '../models/encryption';
import { sendText } from './messaging';
import { renderTemplate } from './sentTemplates';
import { createNotificationAudit } from '../models/notificationAudit';
import { failSwitch, type SwitchNotifyEnv } from './switchService';
import type { EmailEnv } from './email';

/**
 * Switch statuses that warrant a user-facing `switch_update` notification.
 *
 * AC #81 "SUBMITTED, ACCEPTED, ACTIVE, FAILED transitions on switches row" —
 * mapped to the requested-rooted enum (see types/switch.ts ENUM-ALIGNMENT
 * note). `in_progress` is intentionally excluded: it is the retailer-processing
 * intermediate state with no meaningful user action, and the AC does not name
 * it. Keeping this set narrow avoids spamming the user on every micro-transition.
 */
export const NOTIFIABLE_STATUSES: ReadonlySet<SwitchStatus> = new Set([
  'requested',
  'confirmed',
  'completed',
  'failed',
]);

/** PURE predicate: does this transition target warrant a user notification? */
export function isNotifiableStatus(status: SwitchStatus): boolean {
  return NOTIFIABLE_STATUSES.has(status);
}

/**
 * Build the `next_step` copy for the switch_update template's third variable.
 * PURE. Maps each notifiable status to the user's next action / expectation.
 * Kept here (not in the template registry) because it is status-dependent
 * business copy, not template structure.
 */
export function buildNextStep(status: SwitchStatus): string {
  switch (status) {
    case 'requested':
      return "we've sent your request to the retailer — confirmation usually takes 1-2 business days";
    case 'confirmed':
      return 'your new retailer is preparing the switch';
    case 'completed':
      return "you're now on your new plan — allow a few days for the first bill";
    case 'failed':
      return "we couldn't complete this switch automatically — our team will be in touch";
    // in_progress + any future status: no user copy (and isNotifiableStatus
    // already filters in_progress before this is reached in the notify path).
    default:
      return '';
  }
}

/** Display name for the target retailer/plan, falling back to ids. PURE. */
function resolveRetailerName(
  retailerName: string | null,
  fallbackId: string
): string {
  return retailerName && retailerName.length > 0 ? retailerName : fallbackId;
}

export interface NotifySwitchUpdateInput {
  readonly switchRecord: Switch;
  /** Target status the switch just transitioned to. */
  readonly toStatus: SwitchStatus;
  /** Optional failure reason (only meaningful when toStatus='failed'). */
  readonly reason?: string | null;
}

/**
 * Send a `switch_update` notification to the user about a switch milestone.
 * Dedicated-sender path: renderTemplate + sendText + createNotificationAudit.
 *
 * NO-OP (returns false without sending) when:
 *   - toStatus is not in NOTIFIABLE_STATUSES (e.g. in_progress), OR
 *   - the user has no phone on file.
 *
 * RESILIENCE: a send failure is logged + the compliance audit row records
 * `failed`, but this function NEVER throws — the caller (the transition
 * wrapper or the sanity cron) has already committed the state change and a
 * messaging fault must not roll it back. Returns true on successful send.
 */
export async function notifySwitchUpdate(
  env: SwitchNotifyEnv,
  input: NotifySwitchUpdateInput
): Promise<boolean> {
  // ponytail: guard at the boundary so callers can fire-and-forget without
  // re-checking notifiability. One predicate, one place.
  if (!isNotifiableStatus(input.toStatus)) return false;

  const { switchRecord: s, toStatus } = input;
  const encEnv: EncryptionEnv = { ENCRYPTION_KEY: env.ENCRYPTION_KEY };

  const user = await getUserById(env.DB, encEnv, s.userId);
  if (!user || !user.phone) return false;

  // Resolve display names for the template's `to_retailer` variable. The
  // switch stores to_plan_id; the plan carries retailer_id + name.
  const plan = await getPlanById(env.DB, s.toPlanId);
  const retailerId = plan?.retailerId ?? s.fromRetailerId;
  const retailer = await getRetailerById(env.DB, retailerId);
  const toRetailer = resolveRetailerName(
    retailer?.name ?? plan?.name ?? null,
    retailerId
  );

  const message = renderTemplate('switch_update', {
    to_retailer: toRetailer,
    status: toStatus,
    next_step: buildNextStep(toStatus),
  });

  let sentMessageId: string | null = null;
  try {
    const result = await sendText(env.SENT_API_KEY, user.phone, message);
    sentMessageId = result.messageId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    console.log(
      JSON.stringify({
        type: 'switch_update_send_error',
        userId: s.userId,
        switchId: s.id,
        toStatus,
        error: reason,
        timestamp: new Date().toISOString(),
      })
    );
    // Compliance audit: record the failure (no dedup key to set on this path —
    // switch milestones are state-machine events, not daily cadences).
    void createNotificationAudit(env.DB, {
      userId: s.userId,
      notificationType: 'switch_update',
      channel: 'whatsapp',
      template: 'switch_update',
      status: 'failed',
      reason,
    });
    return false;
  }

  void createNotificationAudit(env.DB, {
    userId: s.userId,
    notificationType: 'switch_update',
    channel: 'whatsapp',
    template: 'switch_update',
    sentMessageId,
    status: 'sent',
  });

  console.log(
    JSON.stringify({
      type: 'switch_update_sent',
      userId: s.userId,
      switchId: s.id,
      toStatus,
      timestamp: new Date().toISOString(),
    })
  );
  return true;
}

// ---------------------------------------------------------------------------
// Daily sanity cron — issue #81 "Daily Cron sanity check catches missed
// milestones". This is also the first LIVE TRIGGER for #132's failSwitch +
// ops-email path (previously exported-but-uncalled — see switchService.ts).
// ---------------------------------------------------------------------------

/** Env for the sanity cron: D1 + Sent + encryption (user lookup) + ops email. */
export interface SwitchSanityEnv extends SwitchNotifyEnv, EmailEnv {}

/** Switch is "stuck" after this many days in_progress with no completion. */
export const STUCK_SWITCH_AGE_DAYS = 7;

export interface SwitchSanityResult {
  readonly stuckScanned: number;
  readonly failed: number;
  readonly failedNotifySent: number;
  readonly errors: number;
}

/**
 * Daily sanity check. Scans for switches stuck `in_progress` past the age
 * threshold (no retailer webhook confirmation within STUCK_SWITCH_AGE_DAYS)
 * and marks each failed via `failSwitch` — which fires the #132 ops email.
 *
 * After failing, a `switch_update` is sent to the user (the failed milestone
 * IS notifiable) so they learn their switch needs manual attention.
 *
 * Resilience: each switch is processed independently; an error on one does not
 * abort the others. failSwitch itself swallows email-send errors, and the
 * user notify path swallows its own send errors, so a messaging fault never
 * leaves the switch in a half-failed state.
 */
export async function runSwitchSanityCheck(
  env: SwitchSanityEnv,
  opts: { readonly olderThanDays?: number; readonly now?: Date } = {}
): Promise<SwitchSanityResult> {
  const olderThanDays = opts.olderThanDays ?? STUCK_SWITCH_AGE_DAYS;
  const stuck = await getStuckSwitches(env.DB, { olderThanDays, now: opts.now });

  let failed = 0;
  let failedNotifySent = 0;
  let errors = 0;

  for (const row of stuck) {
    try {
      const reason = `No retailer confirmation within ${olderThanDays} days (sanity cron)`;
      const updated = await failSwitch(env.DB, env, {
        switchId: row.id,
        reason,
        actor: 'cron',
      });
      failed++;

      // The failed milestone is notifiable — tell the user their switch needs
      // manual attention. Fire-and-forget; errors swallowed internally.
      const sent = await notifySwitchUpdate(env, {
        switchRecord: updated,
        toStatus: 'failed',
        reason,
      });
      if (sent) failedNotifySent++;
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : 'unknown';
      console.log(
        JSON.stringify({
          type: 'switch_sanity_row_error',
          switchId: row.id,
          error: message,
          timestamp: new Date().toISOString(),
        })
      );
    }
  }

  console.log(
    JSON.stringify({
      type: 'switch_sanity_run',
      stuck_scanned: stuck.length,
      failed,
      failed_notify_sent: failedNotifySent,
      errors,
      olderThanDays,
      timestamp: new Date().toISOString(),
    })
  );

  return { stuckScanned: stuck.length, failed, failedNotifySent, errors };
}
