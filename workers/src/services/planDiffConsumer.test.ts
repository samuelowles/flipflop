import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consumePlanDiffs, type PlanDiffConsumerEnv } from './planDiffConsumer';

/**
 * Issue #75 — plan-data-change re-compare consumer.
 * Covers each AC:
 *  - reads `plans:diff:{retailer_id}` KV keys
 *  - enqueues each affected user to COMPARE_QUEUE as `{ user_id }`
 *  - 7-day dedup via `recompare:{userId}` KV key
 *  - acks (deletes) the diff key after processing
 *  - daily sanity check: any diff present → recompute
 */

// In-memory KV fake that honours prefix list, TTL put, and strong consistency
// of get-after-put within the same instance.
function createFakeKV(store: Map<string, { value: string; expiresAt?: number }> = new Map()): KVNamespace {
  const kv = store;
  const now = () => Date.now();
  return {
    get: async (key: string) => {
      const entry = kv.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < now()) {
        kv.delete(key);
        return null;
      }
      return entry.value;
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? '';
      const keys: { name: string }[] = [];
      for (const name of kv.keys()) {
        if (!name.startsWith(prefix)) continue;
        const entry = kv.get(name)!;
        if (entry.expiresAt !== undefined && entry.expiresAt < now()) continue;
        keys.push({ name });
      }
      return { keys, list_complete: true };
    },
    put: async (key: string, value: string, opts2?: { expirationTtl?: number }) => {
      const expiresAt = opts2?.expirationTtl !== undefined ? now() + opts2.expirationTtl * 1000 : undefined;
      kv.set(key, { value, expiresAt });
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
  } as unknown as KVNamespace;
}

function createFakeQueue(): { q: Queue<{ user_id: string }>; sends: string[] } {
  const sends: string[] = [];
  const q = {
    send: vi.fn(async (msg: { user_id: string }) => {
      sends.push(msg.user_id);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue<{ user_id: string }>;
  return { q, sends };
}

function createFakeDB(byRetailer: Record<string, string[]>): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          const retailerId = String(args[0]);
          const ids = byRetailer[retailerId] ?? [];
          return { results: ids.map(id => ({ id })), success: true, meta: {} };
        },
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
}

function envWith(
  kvStore: Map<string, { value: string; expiresAt?: number }>,
  byRetailer: Record<string, string[]>,
  queue: Queue<{ user_id: string }>
): PlanDiffConsumerEnv {
  return {
    DB: createFakeDB(byRetailer),
    KV: createFakeKV(kvStore),
    COMPARE_QUEUE: queue,
  };
}

describe('consumePlanDiffs (issue #75)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T08:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues every affected user for a retailer with a pending diff', async () => {
    const store = new Map([
      ['plans:diff:contact', {
        value: JSON.stringify({
          retailer_id: 'contact',
          changed_fields: ['c_per_kwh'],
          detected_at: '2026-07-03T03:00:00Z',
        }),
      }],
    ]);
    const { q, sends } = createFakeQueue();
    const env = envWith(store, { contact: ['u-1', 'u-2', 'u-3'] }, q);

    const result = await consumePlanDiffs(env);

    expect(result.retailersProcessed).toBe(1);
    expect(result.usersEnqueued).toBe(3);
    expect(result.usersSkippedDedup).toBe(0);
    expect(sends).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('acks the diff key so it is not re-consumed on the next tick', async () => {
    const store = new Map([
      ['plans:diff:mercury', {
        value: JSON.stringify({ retailer_id: 'mercury', changed_fields: ['c_per_day'], detected_at: 'x' }),
      }],
    ]);
    const { q } = createFakeQueue();
    const env = envWith(store, { mercury: ['u-9'] }, q);

    await consumePlanDiffs(env);

    expect(store.has('plans:diff:mercury')).toBe(false);
  });

  it('skips users already enqueued within the 7-day dedup window', async () => {
    const store = new Map([
      ['plans:diff:contact', {
        value: JSON.stringify({ retailer_id: 'contact', changed_fields: ['c_per_kwh'], detected_at: '2026-07-03T03:00:00Z' }),
      }],
      // u-1 already re-compared 2 days ago — dedup gate present
      ['recompare:u-1', { value: '2026-07-01T08:00:00Z' }],
    ]);
    const { q, sends } = createFakeQueue();
    const env = envWith(store, { contact: ['u-1', 'u-2'] }, q);

    const result = await consumePlanDiffs(env);

    expect(result.usersEnqueued).toBe(1);
    expect(result.usersSkippedDedup).toBe(1);
    expect(sends).toEqual(['u-2']);
  });

  it('sets a 7-day dedup key when enqueuing each user', async () => {
    const store: Map<string, { value: string; expiresAt?: number }> = new Map([
      ['plans:diff:genesis', {
        value: JSON.stringify({ retailer_id: 'genesis', changed_fields: ['name'], detected_at: 'det' }),
      }],
    ]);
    const { q } = createFakeQueue();
    const env = envWith(store, { genesis: ['u-x'] }, q);

    await consumePlanDiffs(env);

    const gate = store.get('recompare:u-x');
    expect(gate).toBeDefined();
    // ~7 days from now (allowing the seconds-based TTL rounding)
    const ttlMs = (gate!.expiresAt ?? 0) - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('does nothing when there are no pending diff keys (daily sanity no-op)', async () => {
    const store = new Map();
    const { q, sends } = createFakeQueue();
    const env = envWith(store, { contact: ['u-1'] }, q);

    const result = await consumePlanDiffs(env);

    expect(result.retailersProcessed).toBe(0);
    expect(result.usersEnqueued).toBe(0);
    expect(sends).toEqual([]);
  });

  it('handles multiple retailers with diffs in one run', async () => {
    const store = new Map([
      ['plans:diff:contact', {
        value: JSON.stringify({ retailer_id: 'contact', changed_fields: ['c_per_kwh'], detected_at: 'a' }),
      }],
      ['plans:diff:mercury', {
        value: JSON.stringify({ retailer_id: 'mercury', changed_fields: ['c_per_day'], detected_at: 'b' }),
      }],
    ]);
    const { q, sends } = createFakeQueue();
    const env = envWith(store, { contact: ['u-1'], mercury: ['u-2', 'u-3'] }, q);

    const result = await consumePlanDiffs(env);

    expect(result.retailersProcessed).toBe(2);
    expect(result.usersEnqueued).toBe(3);
    expect(sends.sort()).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('acks (deletes) a malformed diff payload instead of looping forever', async () => {
    const store = new Map([
      ['plans:diff:broken', { value: 'not-json-{{' }],
    ]);
    const { q, sends } = createFakeQueue();
    const env = envWith(store, { broken: ['u-1'] }, q);

    const result = await consumePlanDiffs(env);

    expect(result.usersEnqueued).toBe(0);
    expect(sends).toEqual([]);
    expect(store.has('plans:diff:broken')).toBe(false);
  });

  it('rolls back the dedup key if enqueue fails (so next tick can retry)', async () => {
    const store = new Map([
      ['plans:diff:contact', {
        value: JSON.stringify({ retailer_id: 'contact', changed_fields: ['c_per_kwh'], detected_at: 'd' }),
      }],
    ]);
    const failingQueue = {
      send: vi.fn().mockRejectedValue(new Error('queue unavailable')),
      sendBatch: vi.fn(),
    } as unknown as Queue<{ user_id: string }>;
    const env = envWith(store, { contact: ['u-1'] }, failingQueue);

    const result = await consumePlanDiffs(env);

    expect(result.usersEnqueued).toBe(0);
    // dedup gate rolled back so a later tick can retry
    expect(store.has('recompare:u-1')).toBe(false);
    // diff key still acked (avoids infinite loop on a persistently-failing user)
    expect(store.has('plans:diff:contact')).toBe(false);
  });
});
