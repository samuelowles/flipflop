/**
 * Issue #228 — unit tests for the FLOW_TEST_MODE bypass predicate.
 *
 * The bypass must be:
 *   - OFF when FLOW_TEST_MODE is unset / not 'true'
 *   - OFF when the flag is on but no flow trace exists for the user
 *     (per-user scoping — a global flag never bypasses guards for untraced users)
 *   - ON only when flag='true' AND an active trace exists
 *   - fail-closed (OFF) when KV fails
 *
 * Switch dedup is NOT tested here — it lives in switchService and is never
 * bypassed (the route records the stage but never relaxes dedup).
 */

import { describe, it, expect } from 'vitest';
import { isFlowTestBypassActive } from './notificationEngine';
import { startStage } from './flowTrace';

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

describe('isFlowTestBypassActive (issue #228 test-mode toggle)', () => {
  it('is OFF when FLOW_TEST_MODE is unset', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect'); // trace exists
    const bypass = await isFlowTestBypassActive({ KV: kv }, 'u1');
    expect(bypass).toBe(false);
  });

  it('is OFF when FLOW_TEST_MODE is "false"', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect');
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'false' }, 'u1');
    expect(bypass).toBe(false);
  });

  it('is OFF when the flag is on but no trace exists for the user (per-user scope)', async () => {
    const kv = makeKV();
    // No trace seeded for u1.
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'true' }, 'u1');
    expect(bypass).toBe(false);
  });

  it('is ON when flag="true" AND an active trace exists for the user', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect');
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'true' }, 'u1');
    expect(bypass).toBe(true);
  });

  it('is per-user: a trace for u2 does not arm the bypass for u1', async () => {
    const kv = makeKV();
    await startStage(kv, 'u2', 'connect');
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'true' }, 'u1');
    expect(bypass).toBe(false);
  });

  it('fails closed (OFF) when KV.get rejects', async () => {
    const kv = {
      get: () => Promise.reject(new Error('KV down')),
    } as unknown as KVNamespace;
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'true' }, 'u1');
    expect(bypass).toBe(false);
  });

  it('is case-sensitive ("True" does not arm, matching the POWERSWITCH_LIVE gate convention)', async () => {
    const kv = makeKV();
    await startStage(kv, 'u1', 'connect');
    const bypass = await isFlowTestBypassActive({ KV: kv, FLOW_TEST_MODE: 'True' }, 'u1');
    expect(bypass).toBe(false);
  });
});
