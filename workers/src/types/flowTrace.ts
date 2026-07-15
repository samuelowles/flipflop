/**
 * Issue #228 — FlowTrace: per-user pipeline observability (Epic 13 DoD).
 *
 * Mirrors the ScanProgress pattern (types/gmail.ts + emailPoller.ts read/write
 * helpers): a JSON object at KV key `flow:{userId}`, 24h TTL, read-modify-
 * written by services/flowTrace.ts as each pipeline stage transitions.
 *
 * The trace NEVER breaks the pipeline — every flowTrace helper no-ops on KV
 * failure (see services/flowTrace.ts). This file is pure interfaces + a couple
 * of pure constants so it can be imported without runtime cost.
 */

/** The seven observable stages of the `/auth/gmail` → switch pipeline. */
export type FlowStageName =
  | 'connect'
  | 'scan'
  | 'parse'
  | 'powerswitch'
  | 'compare'
  | 'notify'
  | 'switch';

/** Lifecycle status for a single stage. */
export type FlowStageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/**
 * One stage row. Matches the issue spec field-for-field:
 * stage/status/startedAt/finishedAt/detail/error/artifacts.
 */
export interface FlowStage {
  readonly stage: FlowStageName;
  status: FlowStageStatus;
  startedAt?: string; // ISO 8601
  finishedAt?: string; // ISO 8601
  /** Human sentence, e.g. "3 PDFs found, 1 duplicate skipped". */
  detail?: string;
  /** Failure reason, verbatim. Present iff status === 'failed'. */
  error?: string;
  /** Opaque id → value links (billId, comparisonId, notificationId, ...). */
  artifacts?: Record<string, string>;
}

/** The full trace for one user, persisted at `flow:{userId}`. */
export interface FlowTrace {
  readonly userId: string;
  stages: FlowStage[];
  updatedAt: string; // ISO 8601
}

/** KV key for a user's trace. Exported so callers + tests share one source. */
export function flowTraceKey(userId: string): string {
  return `flow:${userId}`;
}

/** KV TTL — 24 hours (issue spec). */
export const FLOW_TRACE_TTL_SECONDS = 24 * 60 * 60;
