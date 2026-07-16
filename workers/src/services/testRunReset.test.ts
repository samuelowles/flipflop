import { describe, it, expect } from 'vitest';
import {
  resetExactKeys,
  resetPrefixes,
  executeReset,
  type ResetEnv,
} from './testRunReset';
// Re-import the real constants the reset claims to use — the assertions below
// fail if resetExactKeys/resetPrefixes ever drift off these (issue #242 AC:
// "import them — no string drift").
import { flowTraceKey } from '../types/flowTrace';
import { resultsCacheKey } from './powerswitchReplay';
import { LAST_POLL_KV_PREFIX, SCAN_PROGRESS_KV_PREFIX } from './emailPoller';
import {
  NOTIFY_COOLDOWN_KEY_PREFIX,
  SEND_DEDUP_KEY_PREFIX,
  COOLDOWN_KEY_PREFIX,
} from './notificationEngine';
import { NOTIFIED_KEY_PREFIX } from './planComparator';
import { KV_KEY_PREFIX } from './conversation';

const UID = 'user-1';
const OTHER = 'user-2';

/**
 * Minimal KV fake supporting get/put/delete/list(prefix). list returns one
 * page (list_complete:true) so the pagination loop in testRunReset runs once.
 */
function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const prefix = opts.prefix ?? '';
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('resetExactKeys / resetPrefixes — no drift vs real constants', () => {
  it('exact keys match the real per-user key builders', () => {
    expect([...resetExactKeys(UID)]).toEqual([
      flowTraceKey(UID),
      resultsCacheKey(UID),
      `${LAST_POLL_KV_PREFIX}${UID}`,
      `${SCAN_PROGRESS_KV_PREFIX}${UID}`,
      `${KV_KEY_PREFIX}${UID}`,
    ]);
  });

  it('prefixes match the real per-user dedup/cooldown prefixes', () => {
    expect([...resetPrefixes(UID)]).toEqual([
      `${NOTIFY_COOLDOWN_KEY_PREFIX}${UID}:`,
      `${SEND_DEDUP_KEY_PREFIX}${UID}:`,
      `${COOLDOWN_KEY_PREFIX}${UID}:`,
      `${NOTIFIED_KEY_PREFIX}${UID}`,
    ]);
  });

  it('exact keys are all scoped to the userId (no global leakage)', () => {
    for (const k of resetExactKeys(UID)) expect(k).toContain(UID);
    for (const p of resetPrefixes(UID)) expect(p).toContain(UID);
  });
});

describe('executeReset', () => {
  it('deletes every target-user key and leaves other users + globals intact', async () => {
    const seed: Record<string, string> = {
      // target user — exact keys
      [flowTraceKey(UID)]: '{}',
      [resultsCacheKey(UID)]: '{}',
      [`${LAST_POLL_KV_PREFIX}${UID}`]: 't',
      [`${SCAN_PROGRESS_KV_PREFIX}${UID}`]: 't',
      [`${KV_KEY_PREFIX}${UID}`]: 't',
      // target user — prefixed dedup/cooldown keys
      [`${NOTIFY_COOLDOWN_KEY_PREFIX}${UID}:plan-a`]: 't',
      [`${SEND_DEDUP_KEY_PREFIX}${UID}:plan-a`]: 't',
      [`${COOLDOWN_KEY_PREFIX}${UID}:plan-a`]: 't',
      [`${NOTIFIED_KEY_PREFIX}${UID}:cmp-1`]: 't',
      // ANOTHER user — must survive
      [flowTraceKey(OTHER)]: '{}',
      [`${COOLDOWN_KEY_PREFIX}${OTHER}:plan-a`]: 't',
      // GLOBAL keys — must survive (never cleared by a per-user reset)
      'powerswitch:drift': '{}',
      'powerswitch:budget:day:2026-07-16': '3',
    };
    const { kv, store } = fakeKV(seed);
    const env: ResetEnv = { KV: kv };

    const { deleted } = await executeReset(env, UID);

    // Every target-user key was deleted (9 total: 5 exact + 4 prefixed).
    expect(deleted).toHaveLength(9);
    for (const k of [
      flowTraceKey(UID),
      resultsCacheKey(UID),
      `${NOTIFY_COOLDOWN_KEY_PREFIX}${UID}:plan-a`,
      `${NOTIFIED_KEY_PREFIX}${UID}:cmp-1`,
    ]) {
      expect(deleted).toContain(k);
      expect(store.has(k)).toBe(false);
    }

    // Other-user keys survive.
    expect(store.has(flowTraceKey(OTHER))).toBe(true);
    expect(store.has(`${COOLDOWN_KEY_PREFIX}${OTHER}:plan-a`)).toBe(true);
    // Global keys survive.
    expect(store.has('powerswitch:drift')).toBe(true);
    expect(store.has('powerswitch:budget:day:2026-07-16')).toBe(true);
  });

  it('deletes nothing (and reports an empty list) for a user with no state', async () => {
    const { kv } = fakeKV({ [flowTraceKey(OTHER)]: '{}' });
    const { deleted } = await executeReset({ KV: kv }, 'never-seen');
    expect(deleted).toHaveLength(0);
  });

  it('is idempotent — a second reset deletes nothing', async () => {
    const { kv } = fakeKV({ [flowTraceKey(UID)]: '{}' });
    await executeReset({ KV: kv }, UID);
    const { deleted } = await executeReset({ KV: kv }, UID);
    expect(deleted).toHaveLength(0);
  });
});
