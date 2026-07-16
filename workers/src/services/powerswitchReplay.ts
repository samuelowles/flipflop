/**
 * #221/#240 — Powerswitch questionnaire replay + per-user results cache + drift flag.
 *
 * Given a user's resolved pxid (from #220, persisted on the user row), replay the
 * Powerswitch questionnaire over HTTP (no headless browser) and persist the
 * parsed plan set to per-user KV for #222 to consume. Rebuilt against the REAL
 * captures in workers/tests/fixtures/powerswitch-live/.
 *
 * PROTOCOL (#240, verified 2026-07-16): the questionnaire is driven by Next.js
 * server actions. The ONLY answer-carrying POSTs in a full walk-through are:
 *
 *   1. POST /questionnaire/household?address_id={pxid}   (HOUSEHOLD_ACTION)
 *      → result.{address, electricity_location, gas_location}. The full address
 *        (incl. x/y) lives HERE, not in autocomplete (which returns only
 *        {a,pxid,v}). The insulation body needs this address verbatim.
 *   2. POST /questionnaire/insulation                    (INSULATION_ACTION)
 *      body: [{profileId:"$undefined", clientProfileData:"<stringified profile>"}]
 *      → line 1: {profile:{…, id:"<token>"}}. The token keys the results call.
 *   3. POST /results?p={token}                            (RESULTS_ACTION)
 *      body: ["<token>"]   ← a SERVER ACTION, NOT a GET (the GET ?_rsc= variants
 *      return 1:null). Line 1: the 15-plan flight #222 parses.
 *
 * The intermediate /questionnaire/<step>?_rsc=… calls in the capture are RSC
 * router PREFETCHES (GET, no body, no Next-Action) — they carry no state and are
 * NOT needed: answers accumulate in a cookie-keyed server-side session, and the
 * insulation POST carries the COMPLETE clientProfileData. So 3 POSTs reproduce
 * the capture. ICP is never submitted (icp:null in the profile; no icp field).
 *
 * COMPLIANCE (docs/POWERSWITCH_COMPLIANCE.md, issue #219):
 *   - LIVE calls GATED behind `env.POWERSWITCH_LIVE === 'true'`. Unset/false →
 *     INERT (no live calls, logs powerswitch_live_disabled, returns `disabled`).
 *     CI uses FIXTURES only (zero live calls).
 *   - ICP NEVER submitted. No code path reads/constructs/posts an ICP value.
 *   - Sequential POSTs with inter-request delay + exponential backoff.
 *   - Identified UA on every request. Per-day request budget.
 *   - Drift: any shape mismatch → set the KV drift flag (48h), log a structured
 *     error, return `drift`. NEVER a partial/garbage write.
 */

import {
  POWERSWITCH_BASE_URL,
  HOUSEHOLD_ACTION,
  INSULATION_ACTION,
  RESULTS_ACTION,
  createCookieJar,
  householdRequestBody,
  postAction,
} from './powerswitchSession';
import {
  parseRscResults,
  findFlightObject,
  type ParsedResults,
  type ParseRscOutcome,
} from './powerswitchRscParser';

/** Local read of the live gate. */
function isLive(env: PowerswitchReplayEnv): boolean {
  return env.POWERSWITCH_LIVE === 'true';
}

// ---------------------------------------------------------------------------
// Etiquette + KV constants
// ---------------------------------------------------------------------------

/** Delay between sequential live POSTs (shared not-for-profit resource). */
const REQUEST_DELAY_MS = 1500;

/** Per-day request budget (UTC day). 3 POSTs/replay ⇒ ~66 replays/day ceiling. */
const DAILY_REQUEST_BUDGET = 200;
const BUDGET_KV_KEY = 'powerswitch:budget:day';

/** Per-user results cache TTL — 7 days (compliance data-retention table). */
const RESULTS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Drift-flag TTL — 48h. Set by the canary/replay on schema mismatch. */
const DRIFT_TTL_SECONDS = 48 * 60 * 60;
const DRIFT_KV_KEY = 'powerswitch:drift';

/** KV key for a user's cached parsed results. */
export function resultsCacheKey(userId: string): string {
  return `powerswitch:results:${userId}`;
}

// ---------------------------------------------------------------------------
// Env + types
// ---------------------------------------------------------------------------

export interface PowerswitchReplayEnv {
  readonly KV: KVNamespace;
  /** #219/#221: gate that keeps the per-user bridge INERT. Defaults false. */
  readonly POWERSWITCH_LIVE?: string;
}

/**
 * Household answers, carried as the Powerswitch wire-format codes the
 * clientProfileData expects (captured 2026-07-16). These ARE the protocol
 * vocabulary; carrying them directly avoids a speculative semantic→code map.
 * DEFAULT_ANSWERS reproduces the capture's profile (the one that returned 15
 * valid plans) so the first live run mirrors a known-good submission.
 * ponytail: per-answer tuning is a later operator concern; the codes are
 * documented inline so a future profile-builder can map from user input.
 */
export interface HouseholdAnswers {
  /** Size code: S|M|L|XL (capture "M" ≈ 3-4 people). */
  readonly householdSize: string;
  /** Someone home weekdays 9-5 (capture false). */
  readonly occupiedWeekdays: boolean;
  /** Main heating source code (capture "HP" = heat pump). */
  readonly mainHeating: string;
  /** Heating sources (capture ["HP"]). */
  readonly heating: readonly string[];
  /** Hot-water sources (capture ["ECL","HP"] — ECL = electric cylinder). */
  readonly hotWater: readonly string[];
  /** Insulation (capture ["CE"] = ceiling). */
  readonly insulation: readonly string[];
  /** Cooking fuel code (capture "EE" = electric). */
  readonly cooking: string;
  /** Has mains/bottled gas (capture false). */
  readonly hasGas: boolean;
  /** Gas source code (capture "NONE"). */
  readonly gasSource: string;
  /** Heat pump used as AC (capture false). */
  readonly heatpumpAircon: boolean;
}

/** Documented safe defaults — reproduces the 2026-07-16 capture profile. */
export const DEFAULT_ANSWERS: HouseholdAnswers = {
  householdSize: 'M',
  occupiedWeekdays: false,
  mainHeating: 'HP',
  heating: ['HP'],
  hotWater: ['ECL', 'HP'],
  insulation: ['CE'],
  cooking: 'EE',
  hasGas: false,
  gasSource: 'NONE',
  heatpumpAircon: false,
};

/** Discriminated replay outcome. Callers route on `status`. */
export type ReplayOutcome =
  | { readonly status: 'ok'; readonly results: ParsedResults; readonly cached: boolean }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly reason: string };

// ---------------------------------------------------------------------------
// Per-user results cache (KV, 7-day TTL)
// ---------------------------------------------------------------------------

/** Read a cached parse for a user (null if absent/expired). */
export async function readCachedResults(
  env: PowerswitchReplayEnv,
  userId: string
): Promise<ParsedResults | null> {
  const raw = await env.KV.get(resultsCacheKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedResults;
  } catch {
    return null;
  }
}

async function writeCachedResults(
  env: PowerswitchReplayEnv,
  userId: string,
  results: ParsedResults
): Promise<void> {
  await env.KV.put(resultsCacheKey(userId), JSON.stringify(results), {
    expirationTtl: RESULTS_TTL_SECONDS,
  });
}

/** Clear the cache (used by the #103 deletion path + tests). */
export async function clearCachedResults(
  env: PowerswitchReplayEnv,
  userId: string
): Promise<void> {
  await env.KV.delete(resultsCacheKey(userId));
}

// ---------------------------------------------------------------------------
// Per-day request budget (shared-resource etiquette)
// ---------------------------------------------------------------------------

/**
 * Increment the UTC-day request counter; return whether the budget holds.
 * Best-effort: a KV race may over-count by one — acceptable for a conservative
 * ceiling on a shared resource.
 */
export async function consumeBudget(
  env: PowerswitchReplayEnv,
  requests: number
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `${BUDGET_KV_KEY}:${today}`;
  const raw = await env.KV.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used + requests > DAILY_REQUEST_BUDGET) return false;
  await env.KV.put(key, String(used + requests), { expirationTtl: 2 * 24 * 60 * 60 });
  return true;
}

// ---------------------------------------------------------------------------
// Drift flag (KV, 48h) — set on schema mismatch; user replays skip while set
// ---------------------------------------------------------------------------

export async function setDriftFlag(env: PowerswitchReplayEnv, reason: string): Promise<void> {
  await env.KV.put(
    DRIFT_KV_KEY,
    JSON.stringify({ reason, at: new Date().toISOString() }),
    { expirationTtl: DRIFT_TTL_SECONDS }
  );
}

export async function isDriftFlagged(env: PowerswitchReplayEnv): Promise<boolean> {
  return (await env.KV.get(DRIFT_KV_KEY)) !== null;
}

export async function clearDriftFlag(env: PowerswitchReplayEnv): Promise<void> {
  await env.KV.delete(DRIFT_KV_KEY);
}

// ---------------------------------------------------------------------------
// clientProfileData builder (the insulation body payload)
// ---------------------------------------------------------------------------

/**
 * Build the clientProfileData object the insulation server action expects.
 * `address` is the household POST's result.address, carried VERBATIM (it holds
 * the x/y + parsed street parts autocomplete does not return). The remaining
 * fields are the captured safe-default shape; answer codes come from
 * HouseholdAnswers. ICP is hard-coded null — never submitted.
 */
export function buildClientProfileData(
  address: Record<string, unknown>,
  electricityLocationId: number,
  gasLocationId: number | null,
  answers: HouseholdAnswers,
  initiatedAt: string
): Record<string, unknown> {
  return {
    address,
    icp: null,
    electricity_retailer_id: null,
    gas_retailer_id: null,
    electricity_location_id: electricityLocationId,
    gas_location_id: gasLocationId,
    electricity_plan_id: null,
    gas_plan_id: null,
    household_size: answers.householdSize,
    main_heating: answers.mainHeating,
    heating: answers.heating,
    hot_water: answers.hotWater,
    insulation: answers.insulation,
    occupied_weekdays: answers.occupiedWeekdays,
    cooking: answers.cooking,
    heatpump_airconditioning: answers.heatpumpAircon,
    initiated_at: initiatedAt,
    has_gas: answers.hasGas,
    gas_source: answers.gasSource,
    area_id: null,
    region_geo_code: null,
    has_bill: false,
    electricity_usage: null,
    gas_usage: null,
    unknown_plan_tariff_overrides: null,
    unknown_plan_tariff_override_active: false,
    unknown_plan_tariff_override_published_plan_id: null,
    unknown_gas_plan_tariff_overrides: null,
    unknown_gas_plan_tariff_override_active: false,
    unknown_gas_plan_tariff_override_published_plan_id: null,
  };
}

// ---------------------------------------------------------------------------
// Flight-response parsing helpers
// ---------------------------------------------------------------------------

interface HouseholdResolve {
  readonly address: Record<string, unknown>;
  readonly electricityLocationId: number;
  readonly gasLocationId: number | null;
}

/** Parse the household POST flight → full address + location ids. Drift → null. */
function parseHouseholdResult(flight: string): HouseholdResolve | null {
  const obj = findFlightObject(flight, 'result');
  if (!obj) return null;
  const result = obj.result;
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const address = r.address;
  if (address === null || typeof address !== 'object') return null;
  const elec = r.electricity_location;
  if (elec === null || typeof elec !== 'object' || typeof (elec as Record<string, unknown>).id !== 'number') {
    return null;
  }
  const gas = r.gas_location;
  const gasId =
    gas && typeof gas === 'object' && typeof (gas as Record<string, unknown>).id === 'number'
      ? ((gas as Record<string, unknown>).id as number)
      : null;
  return {
    address: address as Record<string, unknown>,
    electricityLocationId: (elec as Record<string, unknown>).id as number,
    gasLocationId: gasId,
  };
}

/** Parse the insulation POST flight → the results token (profile.id). Drift → null. */
function parseProfileToken(flight: string): string | null {
  const obj = findFlightObject(flight, 'profile');
  if (!obj) return null;
  const profile = obj.profile;
  if (profile === null || typeof profile !== 'object') return null;
  const id = (profile as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Replay the Powerswitch questionnaire for a user and return the parsed plan
 * set. Reuses the per-user KV cache (7-day TTL) so a cache hit makes ZERO
 * outbound requests. ICP is never submitted at any point in this flow.
 */
export async function replayQuestionnaire(
  env: PowerswitchReplayEnv,
  userId: string,
  pxid: string,
  answers: HouseholdAnswers = DEFAULT_ANSWERS,
  opts: { bypassDriftFlag?: boolean } = {}
): Promise<ReplayOutcome> {
  // 1. Cache hit — zero outbound requests (etiquette + cost).
  const cached = await readCachedResults(env, userId);
  if (cached) return { status: 'ok', results: cached, cached: true };

  // 2. LIVE gate — INERT unless explicitly armed.
  if (!isLive(env)) {
    console.log(JSON.stringify({
      type: 'powerswitch_live_disabled',
      userId,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'disabled' };
  }

  // 3. Drift flag — skip USER replays while the canary reports drift. The canary
  //    itself bypasses this (opts.bypassDriftFlag) since it is the detector that
  //    clears the flag; otherwise a set flag could never be cleared.
  if (!opts.bypassDriftFlag && (await isDriftFlagged(env))) {
    return { status: 'error', reason: 'drift_flag_set' };
  }

  // 4. Per-day budget guard (household + insulation + results = 3 POSTs).
  if (!(await consumeBudget(env, 3))) {
    return { status: 'error', reason: 'daily_request_budget_exhausted' };
  }

  const jar = createCookieJar();
  const householdUrl = `${POWERSWITCH_BASE_URL}/questionnaire/household?address_id=${encodeURIComponent(pxid)}`;
  const insulationUrl = `${POWERSWITCH_BASE_URL}/questionnaire/insulation`;

  // 5. household POST → full address + electricity/gas location ids.
  let householdFlight: string;
  try {
    householdFlight = await postAction(householdUrl, householdRequestBody(pxid), HOUSEHOLD_ACTION, jar);
  } catch (error) {
    return { status: 'error', reason: errMsg(error, 'household_post_failed') };
  }
  const resolved = parseHouseholdResult(householdFlight);
  if (!resolved) {
    await setDriftFlag(env, 'household_result_missing');
    return { status: 'drift', reason: 'household_result_missing' };
  }

  // 6. insulation POST → results token. Carries the COMPLETE clientProfileData.
  await delay(REQUEST_DELAY_MS);
  const profile = buildClientProfileData(
    resolved.address,
    resolved.electricityLocationId,
    resolved.gasLocationId,
    answers,
    new Date().toISOString()
  );
  const insulationBody = [{ profileId: '$undefined', clientProfileData: JSON.stringify(profile) }];
  let insulationFlight: string;
  try {
    insulationFlight = await postAction(insulationUrl, insulationBody, INSULATION_ACTION, jar);
  } catch (error) {
    return { status: 'error', reason: errMsg(error, 'insulation_post_failed') };
  }
  const token = parseProfileToken(insulationFlight);
  if (!token) {
    await setDriftFlag(env, 'insulation_token_missing');
    return { status: 'drift', reason: 'insulation_token_missing' };
  }

  // 7. results POST (server action, body ["<token>"]) → the 15-plan flight.
  await delay(REQUEST_DELAY_MS);
  const resultsUrl = `${POWERSWITCH_BASE_URL}/results?p=${encodeURIComponent(token)}`;
  let resultsFlight: string;
  try {
    resultsFlight = await postAction(resultsUrl, [token], RESULTS_ACTION, jar);
  } catch (error) {
    return { status: 'error', reason: errMsg(error, 'results_post_failed') };
  }

  // 8. Parse + strict-validate. Drift → flag + abort (no partial write).
  const parsed: ParseRscOutcome = parseRscResults(resultsFlight);
  if (parsed.status === 'drift') {
    await setDriftFlag(env, parsed.reason);
    return { status: 'drift', reason: parsed.reason };
  }

  // 9. Persist to per-user KV cache (7-day TTL) for #222 to consume.
  await writeCachedResults(env, userId, parsed.results);

  console.log(JSON.stringify({
    type: 'powerswitch_results_cached',
    userId,
    planCount: parsed.results.plans.length,
    timestamp: new Date().toISOString(),
  }));

  return { status: 'ok', results: parsed.results, cached: false };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
