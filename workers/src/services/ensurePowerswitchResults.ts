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
 *   3. Anything unavailable (live off, no address, drift, error, or a ladder
 *      that returned zero completions on every variant) → null; the caller
 *      falls back to the seeded-plan compare path. This function NEVER throws
 *      pipeline-fatal errors — the drift flag, budget, and ICP rules are
 *      enforced inside the bridge modules themselves.
 *
 * ADDRESS RESOLUTION POLICY (#279): resolveUserAddress now ALWAYS resolves to
 * the closest available completion rather than sending uncertain matches to
 * review. Plans are a function of POSTCODE, not street address (same postcode →
 * same Powerswitch electricity_location → same plans), so substituting a
 * neighbouring address in the user's postcode is harmless, and there is no human
 * review path — `needs_review` used to degrade users to generic seeded plans
 * instead of their real ones. A resolved outcome carries a `confidence` tier
 * (`exact`/`postcode`/`crossed`/`unverified`); the latter two can price the wrong network by
 * design and return plans for the wrong network area, which the bridge emits as
 * a measurable warning. Only a genuinely zero-completion ladder yields
 * `needs_review` here, so this fallback path now fires far less often.
 */

import type { EncryptionEnv } from '../models/encryption';
import { getUserById } from '../models/users';
import { resolveUserAddress, isPowerswitchLive } from './powerswitchSession';
import { replayQuestionnaire, readCachedResults, clearCachedResults } from './powerswitchReplay';
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

  // 1. Read the cache AND the user up front. The user read is now unavoidable
  //    on a cache hit: a null powerswitchPxid is the address-changed signal
  //    (billParser nulls it on a move), and a stale cache entry cached against
  //    the PREVIOUS property would otherwise keep serving the wrong plans for
  //    up to the cache's 7-day TTL (powerswitchReplay RESULTS_TTL_SECONDS) —
  //    the exact failure the address work exists to prevent. The old code
  //    deliberately avoided this DB read on a cache hit; that shortcut is no
  //    longer safe, so we pay one D1 read to check the pxid before trusting it.
  const cached = await readCachedResults(replayEnv, userId);
  const user = await getUserById(env.DB, env, userId);

  // 2. Cache fast-path — but ONLY when the user's pxid is intact. A null pxid
  //    means the address changed since these results were cached, so the entry
  //    is stale: drop it and fall through to the live path to rebuild.
  if (cached && user?.powerswitchPxid) {
    return { status: 'ok', results: cached, source: 'cache' };
  }
  if (cached) {
    await clearCachedResults(replayEnv, userId);
  }

  // 3. Live gate.
  if (!isPowerswitchLive({ DB: env.DB, KV: env.KV, POWERSWITCH_LIVE: env.POWERSWITCH_LIVE })) {
    return { status: 'unavailable', reason: 'live_disabled' };
  }

  // 4. Need the user's pxid; resolve from installation_address if absent.
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

  // 5. Replay (sequential, budgeted, drift-guarded; caches on success).
  const outcome = await replayQuestionnaire(replayEnv, userId, pxid);
  if (outcome.status !== 'ok') {
    return { status: 'unavailable', reason: `replay_${outcome.status}` };
  }
  return { status: 'ok', results: outcome.results, source: 'live' };
}
