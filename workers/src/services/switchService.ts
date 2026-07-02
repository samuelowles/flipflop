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
