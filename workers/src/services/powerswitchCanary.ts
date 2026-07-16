/**
 * #221/#240 — Powerswitch daily drift canary (split from powerswitchReplay.ts).
 *
 * Once a day (cron `0 10 * * *`, wired in index.ts) this runs the full replay
 * flow for ONE fixture address and compares the response shape against the
 * captured schema. On mismatch it sets the KV drift flag (48h) so user-facing
 * replays skip themselves while Powerswitch's deployment has rotated.
 *
 * - LIVE calls ONLY when `POWERSWITCH_LIVE==='true'`. When disabled, logs
 *   `canary_skipped_live_disabled` and runs a fixture-based schema self-test
 *   (parseRscResults against the captured flight) so the parser is exercised in
 *   CI even with the gate closed.
 * - On drift → structured alert + setDriftFlag. On ok → clearDriftFlag.
 *   Mirrors the MONEY_FIELD_MISSING_THRESHOLD philosophy in powerswitchScraper.ts.
 */

import {
  replayQuestionnaire,
  clearDriftFlag,
  DEFAULT_ANSWERS,
  type PowerswitchReplayEnv,
} from './powerswitchReplay';
import { parseRscResults } from './powerswitchRscParser';
import { rsc_results_flight, rsc_results_flight_drift } from './powerswitchLiveFixtures';

/** The fixture address pxid the canary exercises (1 Queen Street, Auckland). */
export const CANARY_FIXTURE_PXID = '2-.1.6.6.1aoR.';
/** Synthetic user id under which the canary's cached result is stored. */
export const CANARY_USER_ID = 'canary-fixture';

export interface CanaryEnv extends PowerswitchReplayEnv {
  readonly DB?: D1Database;
}

/** Discriminated canary outcome. */
export type CanaryOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'skipped_live_disabled' }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

/**
 * Daily drift canary. LIVE only when armed; otherwise a fixture self-test.
 * Sets/clears the KV drift flag so user replays gate themselves on it.
 */
export async function runPowerswitchCanary(env: CanaryEnv): Promise<CanaryOutcome> {
  if (env.POWERSWITCH_LIVE !== 'true') {
    // Fixture self-test: the parser must accept the captured flight and reject
    // the drift variant. Keeps the schema guard exercised in CI, zero live calls.
    const selfTest = canaryFixtureSelfTest();
    console.log(JSON.stringify({
      type: 'canary_skipped_live_disabled',
      selfTest: selfTest ? 'pass' : 'fail',
      timestamp: new Date().toISOString(),
    }));
    return { status: 'skipped_live_disabled' };
  }

  // LIVE canary: full replay for the fixture address. Clear the drift cache so
  // the canary exercises the real chain (not a stale KV hit). Bypasses the drift
  // flag (it is the detector that re-evaluates + clears the flag).
  const outcome = await replayQuestionnaire(env, CANARY_USER_ID, CANARY_FIXTURE_PXID, DEFAULT_ANSWERS, {
    bypassDriftFlag: true,
  });

  if (outcome.status === 'ok') {
    await clearDriftFlag(env);
    console.log(JSON.stringify({
      type: 'powerswitch_canary_ok',
      planCount: outcome.results.plans.length,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'ok' };
  }
  if (outcome.status === 'drift') {
    // replayQuestionnaire already set the drift flag; log the alert.
    console.log(JSON.stringify({
      type: 'powerswitch_canary_drift',
      reason: outcome.reason,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'drift', reason: outcome.reason };
  }
  // disabled / error — surface but do not treat as schema drift.
  const reason = outcome.status === 'error' ? outcome.reason : 'live_disabled_mid_run';
  console.log(JSON.stringify({
    type: 'powerswitch_canary_error',
    reason,
    timestamp: new Date().toISOString(),
  }));
  return { status: 'error', reason };
}

/**
 * Fixture-based schema self-test. The parser must ACCEPT the captured flight and
 * REJECT the drift variant. Used by the canary when POWERSWITCH_LIVE is disabled
 * (and in CI) so the schema guard runs every day.
 */
export function canaryFixtureSelfTest(): boolean {
  const ok = parseRscResults(rsc_results_flight);
  const drift = parseRscResults(rsc_results_flight_drift);
  return ok.status === 'ok' && drift.status === 'drift';
}
