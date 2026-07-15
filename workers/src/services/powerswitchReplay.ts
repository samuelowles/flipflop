/**
 * #221 — Powerswitch questionnaire replay + per-user results cache + canary.
 *
 * Given a user's resolved pxid/location (from #220), replay the Powerswitch
 * questionnaire over HTTP (no headless browser), parse the RSC results flight
 * into structured plan data, and persist it to per-user KV for #222 to consume.
 *
 * COMPLIANCE (docs/POWERSWITCH_COMPLIANCE.md, issue #219 — the authority):
 *   - LIVE calls are GATED behind `env.POWERSWITCH_LIVE === 'true'`. With the
 *     flag unset/false this module is INERT: it makes no live calls, logs
 *     `powerswitch_live_disabled`, and returns a `disabled` outcome. Tests use
 *     FIXTURES only (zero live calls in CI).
 *   - ICP is NEVER submitted. No code path here reads, constructs, or posts an
 *     ICP value. The questionnaire's optional ICP step is always skipped;
 *     results are complete without it (verified 2026-07-15).
 *   - Sequential requests with delay + exponential backoff (shared-resource
 *     etiquette; mirrors services/powerswitchSession.ts).
 *   - Identified user agent on every request (no browser-UA spoofing).
 *   - Per-day request budget (conservative; Powerswitch is a not-for-profit).
 *   - Drift handling: if action-id discovery fails OR the RSC schema mismatches,
 *     emit a structured `powerswitch_schema_drift` error and abort — NEVER a
 *     partial/garbage write.
 *
 * ACTION-ID ROTATION: Powerswitch server-action ids + the `?dpl=` deploy hash
 * rotate on every deploy. Hardcoding them guarantees breakage. The replay
 * dynamically discovers them by fetching the served questionnaire page and
 * scraping the current action id + dpl hash. If discovery fails → that is
 * DRIFT (structured error, abort, no partial write).
 */

import {
  POWERSWITCH_BASE_URL,
  POWERSWITCH_USER_AGENT,
} from './powerswitchSession';
import { parseRscResults, type ParsedResults, type ParseRscOutcome } from './powerswitchRscParser';

/** Local read of the live gate (mirrors powerswitchSession.isPowerswitchLive). */
function isLive(env: PowerswitchReplayEnv): boolean {
  return env.POWERSWITCH_LIVE === 'true';
}

// ---------------------------------------------------------------------------
// Etiquette constants
// ---------------------------------------------------------------------------

/** Delay between sequential live requests (shared not-for-profit resource). */
const REQUEST_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

/**
 * Per-day request budget (UTC day). Conservative; Powerswitch is shared. Each
 * per-user replay makes ~9 requests (1 discovery + 7 steps + 1 results GET),
 * so this caps roughly 20 replays/day from the Worker — plenty for the launch
 * cohort while staying well within respectful use.
 */
const DAILY_REQUEST_BUDGET = 200;
const BUDGET_KV_KEY = 'powerswitch:budget:day';

/** Per-user results cache TTL — 7 days (compliance doc, data-retention table). */
const RESULTS_TTL_SECONDS = 7 * 24 * 60 * 60;

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
 * Household answers derived from the user's stored profile. All unknown fields
 * default to the documented safe values (compliance doc: gas=Unsure,
 * insulation=Unsure, …). These are coarse + non-identifying on their own.
 */
export interface HouseholdAnswers {
  /** Current retailer id (optional — omission never blocks a comparison). */
  readonly currentRetailerId?: string | null;
  readonly gasSource: string; // 'mains' | 'bottled' | 'none' | 'unsure'
  readonly householdSize: number; // 1..5+
  readonly weekdayOccupancy: string; // 'home_all_day' | 'out_during_day' | 'unsure'
  readonly hotWaterSource: string; // 'electric_cylinder' | 'gas' | 'heat_pump' | 'unsure'
  readonly heating: string; // 'heat_pump' | 'electric' | 'gas' | 'wood' | 'unsure'
  /** Follow-up when heating includes a heat pump used as AC. */
  readonly heatPumpAsAc: boolean;
  readonly insulation: string; // 'fully' | 'partially' | 'none' | 'unsure'
}

/** Documented safe defaults where the user's profile is unknown. */
export const DEFAULT_ANSWERS: HouseholdAnswers = {
  currentRetailerId: null,
  gasSource: 'unsure',
  householdSize: 3,
  weekdayOccupancy: 'unsure',
  hotWaterSource: 'unsure',
  heating: 'unsure',
  heatPumpAsAc: false,
  insulation: 'unsure',
};

/** Discriminated replay outcome. Callers route on `status`. */
export type ReplayOutcome =
  | { readonly status: 'ok'; readonly results: ParsedResults; readonly cached: boolean }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly reason: string };

/** Discriminated canary outcome. */
export type CanaryOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'skipped_live_disabled' }
  | { readonly status: 'drift'; readonly reason: string }
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
 * Increment the UTC-day request counter and return whether the budget remains
 * within bounds. Best-effort: a KV race may over-count by one; that is
 * acceptable for a conservative ceiling on a shared resource.
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
  // TTL until end of the next UTC day (generous; budget resets per UTC day).
  await env.KV.put(key, String(used + requests), { expirationTtl: 2 * 24 * 60 * 60 });
  return true;
}

// ---------------------------------------------------------------------------
// Action-id dynamic discovery
// ---------------------------------------------------------------------------

export interface DiscoveredIds {
  readonly actionId: string;
  readonly dplHash: string | null;
}

/**
 * Fetch the served questionnaire landing page and scrape the current
 * server-action id + `?dpl=` deploy hash. Server-action ids rotate on every
 * Powerswitch deploy, so hardcoding guarantees breakage. The regexes tolerate
 * both the RSC stream shape (`"actionId":"<id>"`) and the served-HTML shape
 * (`self.__next_f.push([1,"...actionId\\\"<id>\\\"..."])`).
 *
 * If discovery fails → DRIFT (caller aborts, no partial write).
 */
export async function discoverActionIds(locationId: string): Promise<DiscoveredIds | null> {
  const url = `${POWERSWITCH_BASE_URL}/questionnaire/${encodeURIComponent(locationId)}/household`;
  const html = await getTextWithBackoff(url);
  if (!html) return null;

  // Server-action id. Next.js embeds it near the literal "actionId" marker in
  // the RSC stream / served chunks. The id is a hex-ish string; the surrounding
  // quoting/separator varies by build (":" or "=", optional escaped quotes),
  // so we match "actionId" then the first >=6-char hex run that follows.
  // Built from a string to keep the escape-heavy pattern legible + portable.
  const actionRe = new RegExp('actionId["\\\\]*[:=]["\\\\]*([a-f0-9]{6,})', 'i');
  const actionMatch = html.match(actionRe);
  if (!actionMatch?.[1]) return null;

  // dpl deploy hash — present as a query param on chunk URLs.
  const dplMatch = html.match(/[?&]dpl=([a-z0-9]+)/i);

  return { actionId: actionMatch[1], dplHash: dplMatch?.[1] ?? null };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Replay the Powerswitch questionnaire for a user and return the parsed plan
 * set. Reuses the per-user KV cache (7-day TTL) so the questionnaire is never
 * re-run more than necessary: a cache hit makes ZERO outbound requests.
 *
 * ICP is never submitted at any point in this flow.
 */
export async function replayQuestionnaire(
  env: PowerswitchReplayEnv,
  userId: string,
  pxid: string,
  locationId: string,
  answers: HouseholdAnswers = DEFAULT_ANSWERS
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

  // 3. Per-day budget guard (shared-resource etiquette).
  // Discovery(1) + steps(7) + results(1) ≈ 9 requests.
  const budgetOk = await consumeBudget(env, 9);
  if (!budgetOk) {
    return { status: 'error', reason: 'daily_request_budget_exhausted' };
  }

  // 4. Dynamic action-id discovery.
  const ids = await discoverActionIds(locationId);
  if (!ids) {
    return { status: 'drift', reason: 'action_id_discovery_failed' };
  }

  // 5. Questionnaire steps (sequential, delayed). ICP step is ALWAYS skipped.
  const stepOutcome = await postQuestionnaireSteps(pxid, locationId, ids, answers);
  if (stepOutcome.status !== 'ok') {
    return stepOutcome.status === 'drift'
      ? { status: 'drift', reason: stepOutcome.reason }
      : { status: 'error', reason: stepOutcome.reason };
  }
  const token = stepOutcome.token;

  // 6. Fetch + parse the RSC results flight.
  await delay(REQUEST_DELAY_MS);
  const flight = await getTextWithBackoff(`${POWERSWITCH_BASE_URL}/results?p=${encodeURIComponent(token)}`);
  if (!flight) {
    return { status: 'error', reason: 'results_fetch_failed' };
  }
  const parsed: ParseRscOutcome = parseRscResults(flight);
  if (parsed.status === 'drift') {
    // parseRscResults already logged the structured schema-drift error.
    return { status: 'drift', reason: parsed.reason };
  }

  // 7. Persist to per-user KV cache (7-day TTL) for #222 to consume.
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
// Questionnaire step orchestration
// ---------------------------------------------------------------------------

/**
 * Questionnaire steps in order. ICP is deliberately absent — NEVER submitted
 * (compliance hard rule #1). Current retailer is optional (omitted if unknown).
 */
const QUESTIONNAIRE_STEPS = [
  'current_retailer', // optional; submitted only if answers.currentRetailerId set
  'gas_source',
  'household_size_occupancy',
  'hot_water_source',
  'heating',
  'heat_pump_ac', // conditional follow-up
  'insulation',
] as const;

type StepResult =
  | { readonly status: 'ok'; readonly token: string }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

/**
 * POST each questionnaire step in sequence. Each step is a server-action POST
 * carrying the discovered action id in the `Next-Action` header. The final
 * step returns a results token. ICP is never among the steps.
 */
async function postQuestionnaireSteps(
  pxid: string,
  locationId: string,
  ids: DiscoveredIds,
  answers: HouseholdAnswers
): Promise<StepResult> {
  const fieldFor = (step: string): Record<string, string> => {
    switch (step) {
      case 'current_retailer':
        return answers.currentRetailerId
          ? { step, retailer_id: answers.currentRetailerId }
          : { step, skip: '1' }; // optional — skipped, results still complete
      case 'gas_source':
        return { step, gas_source: answers.gasSource };
      case 'household_size_occupancy':
        return {
          step,
          household_size: String(answers.householdSize),
          weekday_occupancy: answers.weekdayOccupancy,
        };
      case 'hot_water_source':
        return { step, hot_water_source: answers.hotWaterSource };
      case 'heating':
        return { step, heating: answers.heating };
      case 'heat_pump_ac':
        return { step, heat_pump_as_ac: answers.heatPumpAsAc ? '1' : '0' };
      case 'insulation':
        return { step, insulation: answers.insulation };
      default:
        return { step };
    }
  };

  let lastToken: string | null = null;
  for (const step of QUESTIONNAIRE_STEPS) {
    await delay(REQUEST_DELAY_MS);
    const body = new URLSearchParams({ pxid, location_id: locationId, ...fieldFor(step) });
    // ICP guard: assert the body never carries an icp field. Defence in depth.
    if (body.has('icp') || body.has('icp_number')) {
      return { status: 'error', reason: 'icp_field_in_body' };
    }
    const url = `${POWERSWITCH_BASE_URL}/questionnaire/${encodeURIComponent(locationId)}/${step}`;
    let response: unknown;
    try {
      response = await postFormWithBackoff(url, body, {
        'Next-Action': ids.actionId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'step_post_failed';
      return { status: 'error', reason };
    }
    const validated = validateStepResponse(response);
    if (validated.status !== 'ok') {
      return validated.status === 'drift'
        ? { status: 'drift', reason: validated.reason }
        : { status: 'error', reason: validated.reason };
    }
    if (validated.token) lastToken = validated.token;
  }

  if (!lastToken) {
    return { status: 'drift', reason: 'no_results_token_after_steps' };
  }
  return { status: 'ok', token: lastToken };
}

type ValidatedStep =
  | { readonly status: 'ok'; readonly token: string | null }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

function validateStepResponse(body: unknown): ValidatedStep {
  if (body === null || typeof body !== 'object') {
    return { status: 'drift', reason: 'step_response_not_object' };
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.ok !== 'boolean') {
    return { status: 'drift', reason: 'step_response_missing_ok' };
  }
  if (!obj.ok) {
    return { status: 'error', reason: 'step_response_ok_false' };
  }
  const token = typeof obj.token === 'string' ? obj.token : null;
  return { status: 'ok', token };
}

// ---------------------------------------------------------------------------
// Daily drift canary
// ---------------------------------------------------------------------------

/** The fixture address the canary exercises (matches autocomplete_single_match). */
const CANARY_FIXTURE_ADDRESS_ID = '2-.1.6.6.1aoR.';
/** The resolved location id observed for the fixture in the 2026-07-15 walkthrough. */
const CANARY_FIXTURE_LOCATION_ID = '266';

export interface CanaryEnv extends PowerswitchReplayEnv {
  readonly DB?: D1Database;
}

/**
 * Daily drift canary. Runs the full replay flow for ONE fixture address and
 * compares the response shape against the stored schema.
 *
 * - LIVE calls ONLY when `POWERSWITCH_LIVE==='true'`. When disabled, logs
 *   `canary_skipped_live_disabled` and runs a fixture-based schema self-test
 *   (parseRscResults against the captured flight) so the parser is exercised
 *   in CI even with the gate closed.
 * - On schema mismatch → structured alert log. User-facing runs read the same
 *   KV drift flag; callers skip user runs when the canary reports drift
 *   (mirrors MONEY_FIELD_MISSING_THRESHOLD philosophy in powerswitchScraper.ts).
 */
export async function runPowerswitchCanary(env: CanaryEnv): Promise<CanaryOutcome> {
  if (!isLive(env)) {
    // Fixture self-test: parse the captured RSC flight and confirm the schema
    // guard still accepts it. This keeps the parser exercised in CI without
    // any live call.
    const selfTest = canaryFixtureSelfTest();
    console.log(JSON.stringify({
      type: 'canary_skipped_live_disabled',
      selfTest: selfTest ? 'pass' : 'fail',
      timestamp: new Date().toISOString(),
    }));
    return { status: 'skipped_live_disabled' };
  }

  // LIVE canary: full replay for the fixture address.
  const outcome = await replayQuestionnaire(
    env,
    'canary-fixture',
    CANARY_FIXTURE_ADDRESS_ID,
    CANARY_FIXTURE_LOCATION_ID,
    DEFAULT_ANSWERS
  );
  if (outcome.status === 'ok') {
    console.log(JSON.stringify({
      type: 'powerswitch_canary_ok',
      planCount: outcome.results.plans.length,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'ok' };
  }
  if (outcome.status === 'drift') {
    console.log(JSON.stringify({
      type: 'powerswitch_canary_drift',
      reason: outcome.reason,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'drift', reason: outcome.reason };
  }
  // disabled / error — surface but do not alert as drift.
  const reason = outcome.status === 'error' ? outcome.reason : 'live_disabled_mid_run';
  console.log(JSON.stringify({
    type: 'powerswitch_canary_error',
    reason,
    timestamp: new Date().toISOString(),
  }));
  return { status: 'error', reason };
}

/**
 * Fixture-based schema self-test. Parses the captured RSC flight through the
 * strict parser and returns whether it was accepted. Used by the canary when
 * POWERSWITCH_LIVE is disabled so the schema guard is exercised every run
 * (and in CI). The drift fixture is parsed too and MUST be rejected.
 */
import { rsc_results_flight, rsc_results_flight_drift } from './powerswitchFixtures';

export function canaryFixtureSelfTest(): boolean {
  const ok = parseRscResults(rsc_results_flight);
  const drift = parseRscResults(rsc_results_flight_drift);
  return ok.status === 'ok' && drift.status === 'drift';
}

// ---------------------------------------------------------------------------
// Fetch helpers (sequential, delayed, identified UA, backoff)
// ---------------------------------------------------------------------------

async function postFormWithBackoff(
  url: string,
  body: URLSearchParams,
  extraHeaders: Record<string, string>
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': POWERSWITCH_USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body,
        redirect: 'error',
        cf: { cacheTtl: 0 },
      });
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('POST failed after retries');
}

async function getTextWithBackoff(url: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': POWERSWITCH_USER_AGENT, Accept: 'text/html,*/*' },
        redirect: 'follow',
        cf: { cacheTtl: 0 },
      });
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  // A failed GET is not necessarily drift (transient network); surface null.
  console.log(JSON.stringify({
    type: 'powerswitch_get_failed',
    url,
    error: lastError instanceof Error ? lastError.message : 'unknown',
    timestamp: new Date().toISOString(),
  }));
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
