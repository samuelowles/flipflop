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
  TransitionSwitchInput,
} from '../types/switch';
import {
  getSwitchById,
  updateSwitchStatus,
  createSwitchTransition,
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
