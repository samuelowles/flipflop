/**
 * #242 — Reset a user's per-user flow state so the operator can re-run the
 * end-to-end /auth/gmail → switch flow cleanly (see docs/TESTING_RUN.md).
 *
 * Imports the REAL per-user KV key constants/builders from each owning module
 * so this list can NEVER drift from the runtime — verified by
 * testRunReset.test.ts, which re-derives the expected keys from the same
 * imported constants. Driven by the POST /admin/test-run/reset admin route
 * (routes/flow.ts) and the `npm run test-run:reset` client script.
 *
 * Scope: clears the KV keys a single flow run touches. Bills dedup is by
 * source_message_id in D1 and PERSISTS by design — a re-run reports
 * skipped_duplicate (correct). To force full re-ingest, delete the user's
 * bills rows separately (TESTING_RUN.md §5). Global keys (powerswitch:drift,
 * powerswitch:budget:day:*) are intentionally NOT cleared.
 */

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

export interface ResetEnv {
  readonly KV: KVNamespace;
}

/**
 * Exact per-user KV keys a flow run writes — deleted directly (no list needed).
 * Order is stable for readable test fixtures / operator logs.
 */
export function resetExactKeys(userId: string): readonly string[] {
  return [
    flowTraceKey(userId), // flow:{userId} — the trace (#228)
    resultsCacheKey(userId), // powerswitch:results:{userId} — replay cache (#221)
    `${LAST_POLL_KV_PREFIX}${userId}`, // gmail:lastPoll:{userId} — poll cursor
    `${SCAN_PROGRESS_KV_PREFIX}${userId}`, // gmail:scan:{userId} — scan progress
    `${KV_KEY_PREFIX}${userId}`, // state:{userId} — conversation state machine
  ];
}

/**
 * Per-user KV PREFIXES whose variable-suffixed keys must be listed then deleted
 * (dedup/cooldown keys carry a planId/comparisonId suffix).
 */
export function resetPrefixes(userId: string): readonly string[] {
  return [
    `${NOTIFY_COOLDOWN_KEY_PREFIX}${userId}:`, // #74 per-user notify cooldown
    `${SEND_DEDUP_KEY_PREFIX}${userId}:`, // #128 send-side dedup
    `${COOLDOWN_KEY_PREFIX}${userId}:`, // #127 per-user+plan cooldown
    `${NOTIFIED_KEY_PREFIX}${userId}`, // #74 enqueue-side dedup (notified:{userId}:{cmp})
  ];
}

/** List every key under a prefix, paginating until the listing completes. */
async function listByPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return keys;
}

/** Delete every per-user flow key for `userId`. Returns the keys removed. */
export async function executeReset(
  env: ResetEnv,
  userId: string
): Promise<{ readonly deleted: readonly string[] }> {
  const deleted: string[] = [];

  // Exact keys — only count keys that actually existed (cleaner operator log).
  for (const key of resetExactKeys(userId)) {
    if ((await env.KV.get(key)) !== null) {
      await env.KV.delete(key);
      deleted.push(key);
    }
  }

  // Prefixed keys — list each prefix, delete every match.
  for (const prefix of resetPrefixes(userId)) {
    for (const key of await listByPrefix(env.KV, prefix)) {
      await env.KV.delete(key);
      deleted.push(key);
    }
  }

  return { deleted };
}
