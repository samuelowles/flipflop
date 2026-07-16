/**
 * #242 close-out gap — wire the per-user Powerswitch bridge INTO the pipeline.
 *
 * The bridge modules (#220 resolveUserAddress, #221 replayQuestionnaire) shipped
 * but were only ever invoked by the daily canary; the COMPARE consumer read the
 * per-user results cache and, finding it empty (nothing populated it), always
 * fell back to seeded plans — so the runbook's stage-4 expectation
 * (`powerswitch ok — ≥5 plans`) was unreachable for ANY user.
 *
 * This helper is the missing link, called from the COMPARE consumer:
 *   1. Cached results → return them (zero outbound requests).
 *   2. No cache + live: resolve the user's pxid from users.installation_address
 *      if not already stored (#220), then replay the questionnaire (#221) —
 *      which caches the parsed plan set (7-day TTL) and returns it.
 *   3. Anything unavailable (live off, no address, needs_review, drift, error)
 *      → null; the caller falls back to the seeded-plan compare path. This
 *      function NEVER throws pipeline-fatal errors — the drift flag, budget,
 *      and ICP rules are enforced inside the bridge modules themselves.
 */

import type { EncryptionEnv } from '../models/encryption';
import { getUserById } from '../models/users';
import { resolveUserAddress, isPowerswitchLive } from './powerswitchSession';
import { replayQuestionnaire, readCachedResults } from './powerswitchReplay';
import type { ParsedResults } from './powerswitchRscParser';

export interface EnsurePowerswitchEnv extends EncryptionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly POWERSWITCH_LIVE?: string;
}

export type EnsureOutcome =
  | { readonly status: 'ok'; readonly results: ParsedResults; readonly source: 'cache' | 'live' }
  | { readonly status: 'unavailable'; readonly reason: string };

export async function ensurePowerswitchResults(
  env: EnsurePowerswitchEnv,
  userId: string
): Promise<EnsureOutcome> {
  const replayEnv = { KV: env.KV, POWERSWITCH_LIVE: env.POWERSWITCH_LIVE };

  // 1. Cache hit — no outbound requests.
  const cached = await readCachedResults(replayEnv, userId);
  if (cached) return { status: 'ok', results: cached, source: 'cache' };

  // 2. Live gate.
  if (!isPowerswitchLive({ DB: env.DB, KV: env.KV, POWERSWITCH_LIVE: env.POWERSWITCH_LIVE })) {
    return { status: 'unavailable', reason: 'live_disabled' };
  }

  // 3. Need the user's pxid; resolve from installation_address if absent.
  const user = await getUserById(env.DB, env, userId);
  if (!user) return { status: 'unavailable', reason: 'user_not_found' };

  let pxid = user.powerswitchPxid;
  if (!pxid) {
    if (!user.installationAddress) {
      return { status: 'unavailable', reason: 'no_installation_address' };
    }
    const resolved = await resolveUserAddress(
      { DB: env.DB, KV: env.KV, POWERSWITCH_LIVE: env.POWERSWITCH_LIVE },
      userId,
      user.installationAddress
    );
    if (resolved.status !== 'resolved') {
      const inner = 'reason' in resolved ? `: ${resolved.reason}` : '';
      return { status: 'unavailable', reason: `address_${resolved.status}${inner}` };
    }
    pxid = resolved.pxid;
  }

  // 4. Replay (sequential, budgeted, drift-guarded; caches on success).
  const outcome = await replayQuestionnaire(replayEnv, userId, pxid);
  if (outcome.status !== 'ok') {
    return { status: 'unavailable', reason: `replay_${outcome.status}` };
  }
  return { status: 'ok', results: outcome.results, source: 'live' };
}
