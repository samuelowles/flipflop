/**
 * Issue #228 — FlowTrace service tests (Epic 13 DoD).
 *
 * AC coverage:
 *   - stage lifecycle transitions (pending → running → ok / failed / skipped)
 *   - KV-unavailable → no-op (pipeline unaffected, helpers never throw)
 *   - trace JSON shape stable (userId, stages[], updatedAt)
 *   - a failed stage surfaces verbatim error; later stages stay pending
 *   - artifacts accumulate across writes (not clobbered)
 *   - fresh trace seeded on first startStage with all 7 stages present
 */

import { describe, it, expect } from 'vitest';
import {
  startStage,
  finishStage,
  failStage,
  skipStage,
  readFlowTrace,
  FLOW_STAGES,
} from './flowTrace';
import { flowTraceKey } from '../types/flowTrace';

/** Minimal in-memory KVNamespace mock (mirrors emailPoller.test.ts pattern). */
function makeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { store.delete(key); return Promise.resolve(); },
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key: string) =>
      Promise.resolve({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('flowTrace — stage lifecycle transitions', () => {
  it('seeds a fresh trace with all 7 stages on first startStage', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect');

    const trace = await readFlowTrace(kv, 'u1');
    expect(trace).not.toBeNull();
    expect(trace!.userId).toBe('u1');
    expect(trace!.stages.map((s) => s.stage)).toEqual([...FLOW_STAGES]);
    const connect = trace!.stages.find((s) => s.stage === 'connect')!;
    expect(connect.status).toBe('running');
    expect(connect.startedAt).toBeTruthy();
  });

  it('transitions running → ok with detail + artifacts', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'scan');
    await finishStage(kv, 'u1', 'scan', {
      detail: '3 PDFs found',
      artifacts: { billsFound: '3' },
    });

    const trace = await readFlowTrace(kv, 'u1');
    const scan = trace!.stages.find((s) => s.stage === 'scan')!;
    expect(scan.status).toBe('ok');
    expect(scan.detail).toBe('3 PDFs found');
    expect(scan.artifacts).toEqual({ billsFound: '3' });
    expect(scan.finishedAt).toBeTruthy();
  });

  it('transitions running → failed with verbatim error', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'parse');
    await failStage(kv, 'u1', 'parse', 'Python compare service returned 500');

    const trace = await readFlowTrace(kv, 'u1');
    const parse = trace!.stages.find((s) => s.stage === 'parse')!;
    expect(parse.status).toBe('failed');
    expect(parse.error).toBe('Python compare service returned 500');
  });

  it('transitions to skipped with a reason detail', async () => {
    const kv = makeKV();
    await skipStage(kv, 'u1', 'powerswitch', 'live disabled — seeded plans');

    const trace = await readFlowTrace(kv, 'u1');
    const ps = trace!.stages.find((s) => s.stage === 'powerswitch')!;
    expect(ps.status).toBe('skipped');
    expect(ps.detail).toBe('live disabled — seeded plans');
  });

  it('a failed stage leaves later stages pending', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'parse');
    await failStage(kv, 'u1', 'parse', 'corrupt PDF');

    const trace = await readFlowTrace(kv, 'u1');
    const compare = trace!.stages.find((s) => s.stage === 'compare')!;
    const notify = trace!.stages.find((s) => s.stage === 'notify')!;
    expect(compare.status).toBe('pending');
    expect(notify.status).toBe('pending');
  });
});

describe('flowTrace — artifacts accumulate (not clobbered)', () => {
  it('merges new artifacts onto existing ones', async () => {
    const kv = makeKV();
    await finishStage(kv, 'u1', 'compare', { artifacts: { comparisonId: 'c1' } });
    await finishStage(kv, 'u1', 'compare', { artifacts: { recommendation: 'switch' } });

    const trace = await readFlowTrace(kv, 'u1');
    const compare = trace!.stages.find((s) => s.stage === 'compare')!;
    expect(compare.artifacts).toEqual({ comparisonId: 'c1', recommendation: 'switch' });
  });
});

describe('flowTrace — KV unavailable no-ops (pipeline unaffected)', () => {
  it('startStage never throws when KV.get rejects', async () => {
    const kv = {
      get: () => Promise.reject(new Error('KV down')),
      put: () => Promise.reject(new Error('KV down')),
    } as unknown as KVNamespace;
    await expect(startStage(kv, 'u1', 'connect')).resolves.toBeUndefined();
  });

  it('finishStage never throws when KV.put rejects', async () => {
    const kv = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('KV down')),
    } as unknown as KVNamespace;
    await expect(finishStage(kv, 'u1', 'scan', { detail: 'ok' })).resolves.toBeUndefined();
  });

  it('failStage never throws when KV is broken', async () => {
    const kv = {
      get: () => Promise.reject(new Error('KV down')),
      put: () => Promise.reject(new Error('KV down')),
    } as unknown as KVNamespace;
    await expect(failStage(kv, 'u1', 'parse', 'boom')).resolves.toBeUndefined();
  });

  it('readFlowTrace returns null (not throw) when KV.get rejects', async () => {
    const kv = {
      get: () => Promise.reject(new Error('KV down')),
    } as unknown as KVNamespace;
    await expect(readFlowTrace(kv, 'u1')).resolves.toBeNull();
  });

  it('readFlowTrace returns null for a missing key', async () => {
    const kv = makeKV();
    await expect(readFlowTrace(kv, 'never')).resolves.toBeNull();
  });
});

describe('flowTrace — JSON shape stability', () => {
  it('persists at flow:{userId} with the documented top-level shape', async () => {
    const kv = makeKV();
    await startStage(kv, 'user-42', 'connect');

    const raw = kv.store.get(flowTraceKey('user-42'));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.userId).toBe('user-42');
    expect(Array.isArray(parsed.stages)).toBe(true);
    expect(typeof parsed.updatedAt).toBe('string');
    expect(parsed.stages.length).toBe(7);
  });

  it('updatedAt advances on each write', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect');
    const first = (await readFlowTrace(kv, 'u1'))!.updatedAt;
    // Small delay to ensure a distinct timestamp if ms precision is available.
    await new Promise((r) => setTimeout(r, 5));
    await finishStage(kv, 'u1', 'connect');
    const second = (await readFlowTrace(kv, 'u1'))!.updatedAt;
    expect(second >= first).toBe(true);
  });
});

/**
 * Issue #241 — parse stage duration. Gmail-sourced PARSE_QUEUE messages now
 * carry `userId`, so the consumer's startStage(…, 'parse') runs before
 * finishStage(…, 'parse'), producing a real startedAt→finishedAt duration.
 * This test exercises the exact running→ok transition the consumer relies on.
 */
describe('flowTrace — parse stage records a real duration (#241)', () => {
  it('parse stage transitions running → ok with startedAt and finishedAt', async () => {
    const kv = makeKV();
    // Mirrors the index.ts consumer: startStage then finishStage.
    await startStage(kv, 'u-parse', 'parse');
    await new Promise((r) => setTimeout(r, 5));
    await finishStage(kv, 'u-parse', 'parse', { detail: 'parsed' });

    const trace = await readFlowTrace(kv, 'u-parse');
    expect(trace).not.toBeNull();
    const parse = trace!.stages.find((s) => s.stage === 'parse')!;
    expect(parse.status).toBe('ok');
    expect(parse.startedAt).toBeTruthy();
    expect(parse.finishedAt).toBeTruthy();
    // Real, non-negative duration.
    const dur = new Date(parse.finishedAt!).getTime() - new Date(parse.startedAt!).getTime();
    expect(dur).toBeGreaterThanOrEqual(0);
  });
});
