/**
 * Issue #228 — FlowTrace read-modify-write helpers (Epic 13 DoD).
 *
 * Mirrors emailPoller's writeScanProgress/readScanProgress: a thin KV JSON
 * wrapper. CRITICAL INVARIANT: every function NO-OPS on any KV failure — the
 * trace must never break the pipeline. All KV ops are wrapped in try/catch.
 */

import {
  flowTraceKey,
  FLOW_TRACE_TTL_SECONDS,
  MAX_FLOW_EVENTS,
  type FlowStage,
  type FlowStageName,
  type FlowStageStatus,
  type FlowTrace,
} from '../types/flowTrace';

/** All stages in pipeline order (used to seed a fresh trace). */
export const FLOW_STAGES: readonly FlowStageName[] = [
  'connect', 'scan', 'parse', 'powerswitch', 'compare', 'notify', 'switch',
];

function freshTrace(userId: string): FlowTrace {
  return { userId, stages: FLOW_STAGES.map((s) => ({ stage: s, status: 'pending' })), updatedAt: '' };
}

function rowFor(trace: FlowTrace, stage: FlowStageName): FlowStage {
  const existing = trace.stages.find((s) => s.stage === stage);
  if (existing) return existing;
  const row: FlowStage = { stage, status: 'pending' };
  trace.stages.push(row);
  return row;
}

async function mutate(kv: KVNamespace, userId: string, fn: (trace: FlowTrace) => void): Promise<void> {
  try {
    let trace: FlowTrace | null = null;
    const raw = await kv.get(flowTraceKey(userId));
    if (raw) trace = JSON.parse(raw) as FlowTrace;
    if (!trace) trace = freshTrace(userId);
    fn(trace);
    trace.updatedAt = new Date().toISOString();
    await kv.put(flowTraceKey(userId), JSON.stringify(trace), { expirationTtl: FLOW_TRACE_TTL_SECONDS });
  } catch {
    // NO-OP — the trace must never break the pipeline (#228 invariant).
  }
}

function apply(
  trace: FlowTrace,
  stage: FlowStageName,
  status: FlowStageStatus,
  patch: { detail?: string; error?: string; artifacts?: Record<string, string>; ts: string }
): void {
  const row = rowFor(trace, stage);
  row.status = status;
  if (status === 'running') row.startedAt = patch.ts;
  else row.finishedAt = patch.ts;
  if (patch.detail !== undefined) row.detail = patch.detail;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.artifacts) row.artifacts = { ...(row.artifacts ?? {}), ...patch.artifacts };

  // Append-only event log: every transition, verbatim, so multi-bill runs
  // stay readable (the stage table above is one-row-per-stage and each new
  // bill overwrites the last one's story).
  const events = trace.events ?? (trace.events = []);
  events.push({
    ts: patch.ts,
    stage,
    status,
    ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.artifacts ? { artifacts: patch.artifacts } : {}),
  });
  if (events.length > MAX_FLOW_EVENTS) events.splice(0, events.length - MAX_FLOW_EVENTS);
}

/** Mark a stage running (records startedAt). Seeds the trace if absent. */
export async function startStage(kv: KVNamespace, userId: string, stage: FlowStageName): Promise<void> {
  const ts = new Date().toISOString();
  await mutate(kv, userId, (t) => { apply(t, stage, 'running', { ts }); });
}

/** Mark a stage ok with an optional human detail + artifact links. */
export async function finishStage(
  kv: KVNamespace,
  userId: string,
  stage: FlowStageName,
  result?: { detail?: string; artifacts?: Record<string, string> }
): Promise<void> {
  const ts = new Date().toISOString();
  await mutate(kv, userId, (t) => { apply(t, stage, 'ok', { ...result, ts }); });
}

/** Mark a stage failed with the verbatim error. */
export async function failStage(kv: KVNamespace, userId: string, stage: FlowStageName, error: string): Promise<void> {
  const ts = new Date().toISOString();
  await mutate(kv, userId, (t) => { apply(t, stage, 'failed', { error, ts }); });
}

/** Mark a stage skipped with a reason (e.g. "live disabled — seeded plans"). */
export async function skipStage(kv: KVNamespace, userId: string, stage: FlowStageName, detail: string): Promise<void> {
  const ts = new Date().toISOString();
  await mutate(kv, userId, (t) => { apply(t, stage, 'skipped', { detail, ts }); });
}

/** Read the trace (null if absent). For the /flow/status.json route. */
export async function readFlowTrace(kv: KVNamespace, userId: string): Promise<FlowTrace | null> {
  try {
    const raw = await kv.get(flowTraceKey(userId));
    return raw ? (JSON.parse(raw) as FlowTrace) : null;
  } catch {
    return null;
  }
}
