export type SwitchStatus = 'requested' | 'confirmed' | 'in_progress' | 'completed' | 'failed';

export interface Switch {
  readonly id: string;
  readonly userId: string;
  readonly fromRetailerId: string;
  readonly toPlanId: string;
  readonly status: SwitchStatus;
  readonly requestedAt: string; // ISO 8601
  readonly confirmedAt: string | null; // ISO 8601
  readonly completedAt: string | null; // ISO 8601
  // --- AC #129 (migration 0016): captured on `failed` transitions; consumed
  // by issue #132 (email fallback) to explain why a switch did not complete. ---
  readonly failureReason?: string | null;
}

// ---------------------------------------------------------------------------
// Issue #129 — switch state machine transition log.
//
// ENUM-ALIGNMENT NOTE: the issue title lists `initiated` as the start state,
// but the EXISTING CHECK constraint on `switches.status` (0001_initial.sql)
// uses `requested`. `requested` IS the "initiated" start state; we do not
// rename it (a CHECK change requires a temp-table rebuild — out of scope).
// ---------------------------------------------------------------------------

/** Who or what triggered a transition. AC #129 "by". */
export type SwitchTransitionActor = 'system' | 'user' | 'webhook' | 'cron';

/** One row in the switch_transitions audit log (camelCase view of D1 row). */
export interface SwitchTransition {
  readonly id: string;
  readonly switchId: string;
  readonly fromStatus: SwitchStatus | null; // null on the initial creation row
  readonly toStatus: SwitchStatus;
  readonly actor: SwitchTransitionActor;
  readonly reason: string | null;
  readonly at: string; // ISO 8601
}

/** Input to transitionSwitch (issue #129 service). */
export interface TransitionSwitchInput {
  readonly switchId: string;
  readonly toStatus: SwitchStatus;
  readonly actor: SwitchTransitionActor;
  readonly reason?: string | null;
  /** Set when transitioning to `failed` (persisted to switches.failure_reason). */
  readonly failureReason?: string | null;
}
