/**
 * Issue #129 (Epic #8) — switch state machine.
 *
 * This module is the TRUST BOUNDARY for switch state changes: every status
 * transition on a `switches` row must go through `transitionSwitch`, which
 * (a) validates the transition against a strict table, (b) updates the row,
 * (c) writes a `switch_transitions` audit row carrying from/to/actor/reason.
 *
 * ENUM-ALIGNMENT: the issue title names the start state `initiated`, but the
 * existing CHECK constraint on `switches.status` (0001) uses `requested`.
 * `requested` is the "initiated" state — see types/switch.ts + migration 0016.
 */
import type {
  Switch,
  SwitchStatus,
  SwitchTransitionActor,
  TransitionSwitchInput,
} from '../types/switch';
import {
  getSwitchById,
  updateSwitchStatus,
  createSwitchTransition,
  createSwitch as insertSwitch,
  getActiveSwitchForUserAndPlan,
} from '../models/switches';
import { sendEmail, type EmailEnv, type BuiltEmail } from './email';

/**
 * Strict transition table. AC #129 "Transitions guarded by a strict table".
 *
 * Derivation (mapped to the existing `requested`-rooted enum):
 *   requested  -> { confirmed, failed }
 *   confirmed  -> { in_progress, failed }
 *   in_progress-> { completed, failed }
 *   completed  -> { failed }            // AC "retry possible from completed=false"
 *   failed     -> {} (terminal; retry is a NEW switch request, not a reopen)
 *
 * `completed -> failed` covers "completed but later found to have failed"
 * (e.g. switch reverted). `failed` is terminal — AC's "retry possible from
 * completed=false state" means a fresh switch request, not reopening a dead
 * one (that would lose the audit trail).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<SwitchStatus, readonly SwitchStatus[]>> = {
  requested: ['confirmed', 'failed'],
  confirmed: ['in_progress', 'failed'],
  in_progress: ['completed', 'failed'],
  completed: ['failed'],
  failed: [],
};

/**
 * Pure predicate: is `from -> to` a legal transition?
 * Unit-testable without D1. Null `from` is legal only when `to` is the start
 * state (`requested`) — used by the initial creation path.
 */
export function isValidTransition(
  from: SwitchStatus | null,
  to: SwitchStatus
): boolean {
  if (from === null) return to === 'requested';
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Validate + apply a switch state transition. Trust boundary.
 *
 * Reads the current status, checks isValidTransition, updates the switch row
 * (stamping confirmed_at / completed_at / failure_reason as appropriate), and
 * inserts a switch_transitions audit row. Throws on illegal transition or if
 * the switch does not exist.
 *
 * Returns the post-transition Switch.
 */
export async function transitionSwitch(
  db: D1Database,
  input: TransitionSwitchInput
): Promise<Switch> {
  const current = await getSwitchById(db, input.switchId);
  if (!current) {
    throw new Error(`Switch not found: ${input.switchId}`);
  }

  if (!isValidTransition(current.status, input.toStatus)) {
    // ponytail: plain Error — the boundary rejects; callers decide retry/HTTP.
    // No custom class for a single error site (would be speculative abstraction).
    throw new Error(
      `Illegal switch transition: ${current.status} -> ${input.toStatus} (switch ${input.switchId})`
    );
  }

  await updateSwitchStatus(
    db,
    input.switchId,
    input.toStatus,
    input.failureReason ?? undefined
  );

  await createSwitchTransition(db, {
    switchId: input.switchId,
    fromStatus: current.status,
    toStatus: input.toStatus,
    actor: input.actor,
    reason: input.reason ?? null,
  });

  const updated = await getSwitchById(db, input.switchId);
  if (!updated) {
    throw new Error(`Switch vanished mid-transition: ${input.switchId}`);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Issue #130 — switch request creation with duplicate-active validation.
//
// Validation rule: a user MUST NOT have two active (non-terminal) switches for
// the SAME plan. Different plans are allowed. Active = status IN
// (requested, confirmed, in_progress) — matches getActiveSwitchForUser.
//
// SEAM for #131: this returns the created Switch record only. Issue #131 will
// extend the response with the retailer deep-link / switch URL. The seam is
// the return value — #131 wraps createSwitch and appends `switchUrl`.
// ---------------------------------------------------------------------------

/** Thrown when an active switch already exists for the (user, plan) pair.
 *  Callers map this to HTTP 409 Conflict. */
export class DuplicateActiveSwitchError extends Error {
  readonly existingSwitchId: string;
  constructor(existingSwitchId: string) {
    super(
      `An active switch already exists for this user + plan (switch ${existingSwitchId})`
    );
    this.name = 'DuplicateActiveSwitchError';
    this.existingSwitchId = existingSwitchId;
  }
}

export interface CreateSwitchRequestInput {
  readonly userId: string;
  readonly fromRetailerId: string;
  readonly toPlanId: string;
  readonly actor: SwitchTransitionActor;
}

/**
 * Create a new switch request, validating no duplicate active switch exists
 * for the same (user, plan). Inserts the switch in `requested` status and
 * writes the initial `switch_transitions` row (from_status=null → requested,
 * actor, reason='created'). AC #130 "Idempotent on retries: 2 clicks = 1 switch".
 *
 * Throws `DuplicateActiveSwitchError` if an active switch already exists for
 * the (user, plan) pair.
 */
export async function createSwitch(
  db: D1Database,
  input: CreateSwitchRequestInput
): Promise<Switch> {
  const existing = await getActiveSwitchForUserAndPlan(
    db,
    input.userId,
    input.toPlanId
  );
  if (existing) {
    throw new DuplicateActiveSwitchError(existing.id);
  }

  // ponytail: reuse the model's raw INSERT (single source of truth for the
  // switches row shape) rather than duplicating the SQL here.
  const switchRecord = await insertSwitch(db, {
    userId: input.userId,
    fromRetailerId: input.fromRetailerId,
    toPlanId: input.toPlanId,
  });

  await createSwitchTransition(db, {
    switchId: switchRecord.id,
    fromStatus: null,
    toStatus: 'requested',
    actor: input.actor,
    reason: 'created',
  });

  return switchRecord;
}

// ---------------------------------------------------------------------------
// Issue #132 — switch failure path + ops email fallback (bcc ops@flip).
//
// `failSwitch` is the SINGLE call site that marks a switch `failed` AND fires
// the ops alert. It is exported so future failure triggers (webhook reporting
// retailer rejection, sanity cron #81, Epic #9 confirmation-timeout) all route
// through one place — guaranteeing the ops email fires on every failure.
//
// FAILURE-TOLERANCE CONTRACT: the switch is transitioned to `failed` FIRST; the
// ops email send is fire-and-forget and its errors are swallowed by `sendEmail`
// (which never throws). A broken email provider or a missing RESEND_API_KEY
// MUST NEVER roll back the state transition. The switch is already failed; the
// email is best-effort triage. See services/email.ts for the inert-by-default
// log-only fallback path.
//
// TRIGGER WIRING: today no live failure trigger exists in the repo — the
// retailer adapter (#131) is a deep-link builder that cannot fail at request
// time, and the webhook/cron failure sources land with #81 / Epic #9. So
// `failSwitch` is EXPORTED but not yet called from a route. Issue #81 will wire
// the cron sanity-check trigger; Epic #9 will wire the retailer-webhook trigger.
// A unit test proves the email fires on failure here; the integration wiring is
// tracked in those issues. Do NOT invent a fake trigger.
//
// PII STANCE: the ops alert is INTERNAL. It carries the opaque switch id +
// user_id + retailer/plan ids + reason. It NEVER includes raw phone/email/name.
// ---------------------------------------------------------------------------

/** Optional context that enriches the ops email (retailer/plan display names). */
export interface SwitchFailureContext {
  /** Display name of the FROM retailer, if known. Falls back to the id. */
  readonly fromRetailerName?: string | null;
  /** Display name of the TARGET retailer, if known. Falls back to the id. */
  readonly toRetailerName?: string | null;
  /** Display name of the target plan, if known. Falls back to the id. */
  readonly toPlanName?: string | null;
}

/** Context needed to build a deep-link into the admin switch view, if one exists. */
export interface SwitchFailureAdminLink {
  /** Base URL of the admin app, e.g. https://admin.flip.nz. */
  readonly adminBaseUrl?: string | null;
}

/** Input to the pure email-content builder (no network, no env). */
export interface BuildSwitchFailureEmailInput {
  readonly switchRecord: Switch;
  readonly reason: string;
  readonly context?: SwitchFailureContext;
  readonly adminLink?: SwitchFailureAdminLink;
}

/**
 * PURE: build the ops failure-alert email subject + text body.
 *
 * AC #132 subject: "Power switch ? manual steps needed" — the `?` in the issue
 * is an emoji placeholder (the issue body renders it as such). We use a plain
 * text subject because (a) Resend + email clients render emoji inconsistently,
 * (b) ops-alert subjects should be greppable, (c) the user-facing version of
 * this email (Epic #12) will carry the emoji once there's a rendered HTML body.
 * The exact AC wording is preserved in the subject text for traceability.
 *
 * PII: includes opaque user_id (internal) but NO raw phone/email/name. The body
 * lists the 3 manual steps (AC #132 "Body lists the 3 steps to complete the
 * switch on the retailer's site") so a human ops member can paste them to the
 * user via the existing WhatsApp/SMS channel if needed.
 */
export function buildSwitchFailureEmail(
  input: BuildSwitchFailureEmailInput
): BuiltEmail {
  const { switchRecord: s, reason, context, adminLink } = input;

  // AC #132 subject (emoji placeholder kept verbatim from the issue for grep).
  const subject = 'Power switch ? manual steps needed';

  const fromRetailer = context?.fromRetailerName ?? s.fromRetailerId;
  const toRetailer =
    context?.toRetailerName ?? context?.toPlanName ?? s.toPlanId;
  const toPlan = context?.toPlanName ?? s.toPlanId;

  // Admin deep-link to the switch record, if an admin base URL is configured.
  const adminUrl = adminLink?.adminBaseUrl
    ? `${adminLink.adminBaseUrl.replace(/\/$/, '')}/switches/${s.id}`
    : '(admin URL not configured)';

  // AC #132 "Body lists the 3 steps to complete the switch on the retailer's site".
  // These are the canonical NZ power-switch manual steps; a human ops member
  // can relay them to the user over WhatsApp/SMS if the automated flow failed.
  const steps = [
    '1. Open your current retailer\'s "move house / switch away" page.',
    `2. Have your new retailer (${toRetailer}) plan details ready: ${toPlan}.`,
    '3. Submit the switch request on their site — confirmation takes 1-2 business days.',
  ].join('\n');

  const text = [
    `Switch ${s.id} failed and could not be completed automatically.`,
    '',
    `User (internal id): ${s.userId}`,
    `From retailer: ${fromRetailer}`,
    `To retailer / plan: ${toRetailer} / ${toPlan}`,
    `Failure reason: ${reason}`,
    `Requested at: ${s.requestedAt}`,
    '',
    'Manual steps for the user:',
    steps,
    '',
    `Admin view: ${adminUrl}`,
    '',
    '— Flip ops (automated alert, bcc ops@flip)',
  ].join('\n');

  return { subject, text };
}

/** Input to failSwitch. */
export interface FailSwitchInput {
  readonly switchId: string;
  /** Why the switch failed — persisted to switches.failure_reason (AC #132). */
  readonly reason: string;
  /** Who/what triggered the failure (webhook, cron, system). */
  readonly actor: SwitchTransitionActor;
  /** Optional display-name context for the ops email. */
  readonly context?: SwitchFailureContext;
  /** Optional admin base URL for the deep-link in the email body. */
  readonly adminLink?: SwitchFailureAdminLink;
  /** Ops recipient (To:). Defaults to OPS_EMAIL or ops@flip.nz. */
  readonly opsTo?: string;
}

/**
 * Mark a switch `failed` (transitioning through the strict table + writing the
 * audit row + setting failure_reason), then fire the ops alert email (bcc
 * ops@flip). AC #132 "Switch row marked status=failed with reason field populated"
 * + "BCC: ops@flip".
 *
 * ORDERING: transition FIRST, email SECOND. If transitionSwitch throws (illegal
 * transition, missing switch), the email is NOT sent — that's correct, the
 * failure didn't actually happen. If transitionSwitch succeeds, the email send
 * is best-effort and can never roll back the state.
 *
 * Returns the post-failure Switch record.
 */
export async function failSwitch(
  db: D1Database,
  env: EmailEnv,
  input: FailSwitchInput
): Promise<Switch> {
  const updated = await transitionSwitch(db, {
    switchId: input.switchId,
    toStatus: 'failed',
    actor: input.actor,
    reason: input.reason,
    failureReason: input.reason,
  });

  // Fire-and-forget ops alert. sendEmail swallows all errors (failure-tolerance
  // contract) so this await never throws — but we wrap defensively in case a
  // future caller swaps in a throwing sender.
  const email = buildSwitchFailureEmail({
    switchRecord: updated,
    reason: input.reason,
    context: input.context,
    adminLink: input.adminLink,
  });

  const opsTo = input.opsTo ?? env.OPS_EMAIL ?? 'ops@flip.nz';
  try {
    await sendEmail(env, {
      email,
      to: opsTo,
      bcc: 'ops@flip.nz',
    });
  } catch (err) {
    // ponytail: defensive double-swallow. sendEmail already swallows, but if a
    // future sender throws, the switch MUST stay failed. Log + move on.
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        level: 'error',
        type: 'failSwitch_email_swallowed',
        switch_id: input.switchId,
        message,
        timestamp: new Date().toISOString(),
      })
    );
  }

  return updated;
}
