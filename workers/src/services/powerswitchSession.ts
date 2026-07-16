/**
 * #220/#240 — Powerswitch per-user address resolution (rebuilt against REAL captures).
 *
 * Given a user's NZ address string, resolve it to a Powerswitch `pxid`
 * (Addressfinder address id) + internal location id, and persist both on the
 * user row (migration 0018) so the per-user replay (#221) can run without
 * re-resolving. Rebuilt against workers/tests/fixtures/powerswitch-live/
 * {03-autocomplete,07-q-household}.res.txt — every request byte traces there.
 *
 * PROTOCOL CORRECTION (#240): the questionnaire is driven by Next.js server
 * actions, NOT form endpoints or redirects. Each call is `POST <url>` with
 * `Content-Type: text/plain;charset=UTF-8`, `Accept: text/x-component`, a
 * `Next-Action: <hash>` header (deployment-bound — rotation is drift), and a
 * JSON-array body. The response is an RSC FLIGHT (text/x-component); the payload
 * is the `1:{…}` row. Address → location is `POST /questionnaire/household`
 * returning `{result:{electricity_location:{id:267,…}}}` — NOT a Location-header
 * redirect. The session is cookie-keyed, so a CookieJar threads autocomplete →
 * household (capture README: "server-side session profile keyed by cookie").
 *
 * COMPLIANCE (docs/POWERSWITCH_COMPLIANCE.md, issue #219):
 *   - LIVE per-user calls are GATED behind `env.POWERSWITCH_LIVE === 'true'`.
 *     With the flag unset/false this module is INERT (no live calls, logs
 *     `powerswitch_live_disabled`, returns `disabled`). CI uses FIXTURES only.
 *   - ICP is NEVER submitted — `icp_identifier: "$undefined"` in the household
 *     body. No code path reads, constructs, or posts an ICP value.
 *   - Sequential requests with delay + exponential backoff (shared-resource
 *     etiquette; mirrors services/powerswitchScraper.ts).
 *   - Identified user agent on every request (no browser-UA spoofing).
 *   - Drift: a response lacking the expected flight shape → structured
 *     `console.error('powerswitch_drift', …)` + typed `drift` failure. Never
 *     persists a partial/garbage guess.
 */

import { updatePowerswitchLocation } from '../models/users';
import { findFlightObject } from './powerswitchRscParser';

/** Base URL. Public site; no auth. */
export const POWERSWITCH_BASE_URL = 'https://www.powerswitch.org.nz';

/**
 * Identified user agent. Same string the capture harness + scraper use so
 * Powerswitch sees one consistent Flip identity across all surfaces.
 */
export const POWERSWITCH_USER_AGENT =
  'FlipNZ-BillMonitor/1.0 (+https://flip.nz; issue #240; contact: ops@flip.nz)';

/**
 * Captured Next.js server-action hashes (deployment-bound — from the
 * NN-*.req.txt captures). When Powerswitch redeploys these rotate; the live
 * calls then 4xx and the daily drift canary raises + sets the KV drift flag.
 */
export const AUTOCOMPLETE_ACTION = 'da6fc133fa56dbcc912a48743ab36b5923271146'; // 03-autocomplete.req.txt
export const HOUSEHOLD_ACTION = '6a3f72e4062eaddbfb90c89ee71031b9eefdbbfb'; // 07-q-household.req.txt
export const INSULATION_ACTION = '95a1d5c6e2700a5cf6efd321d66b0dc867ac2b9c'; // 16-q-insulation.req.txt
export const RESULTS_ACTION = 'c22005b4ec83d0b95d0791579a9249f182c212c4'; // 18-results.req.txt

/** Etiquette constants — conservative; Powerswitch is a shared not-for-profit resource. */
const REQUEST_DELAY_MS = 1500; // delay between the autocomplete + household calls
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

/** Cookie jar threading the cookie-keyed session across the POST chain. */
export interface CookieJar {
  cookies: string[]; // "name=value" entries
}

export function createCookieJar(): CookieJar {
  return { cookies: [] };
}

/** Env shape this module needs. KV is reserved for #221's results cache + drift flag. */
export interface PowerswitchSessionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  /** #219/#220: gate that keeps the per-user bridge INERT. Defaults false. */
  readonly POWERSWITCH_LIVE?: string;
}

/** Expected autocomplete completion entry shape (03-autocomplete.res.txt). */
export interface PowerswitchCompletion {
  readonly a: string;
  readonly pxid: string;
  readonly v: number;
}

/** Discriminated outcome of a resolve attempt. Callers route on `status`. */
export type ResolveAddressOutcome =
  | { readonly status: 'resolved'; readonly pxid: string; readonly locationId: string | null }
  | { readonly status: 'needs_review'; readonly reason: 'zero_match' | 'ambiguous'; readonly completions: number }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly reason: string };

/** Whether the per-user bridge is armed. Ships false; flip via wrangler secret. */
export function isPowerswitchLive(env: PowerswitchSessionEnv): boolean {
  return env.POWERSWITCH_LIVE === 'true';
}

/**
 * Resolve a user's address string to a pxid (+ location id) and persist both
 * on the user row. Returns a typed outcome — callers route `needs_review` /
 * `drift` to the manual-review path. Never persists a guess. ICP is never
 * submitted. One cookie-keyed session threads autocomplete → household.
 */
export async function resolveUserAddress(
  env: PowerswitchSessionEnv,
  userId: string,
  address: string
): Promise<ResolveAddressOutcome> {
  if (!isPowerswitchLive(env)) {
    console.log(JSON.stringify({
      type: 'powerswitch_live_disabled',
      userId,
      timestamp: new Date().toISOString(),
    }));
    return { status: 'disabled' };
  }

  const trimmed = address.trim();
  if (!trimmed) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }

  const jar = createCookieJar();

  // 1. Autocomplete — POST / (server-action), text/plain body ["<address>"].
  const completionOutcome = await fetchCompletions(trimmed, jar);
  if (completionOutcome.status !== 'ok') {
    return completionOutcome.status === 'drift'
      ? { status: 'drift', reason: completionOutcome.reason }
      : { status: 'error', reason: completionOutcome.reason };
  }
  const completions = completionOutcome.completions;

  // 2. Match-confidence decision.
  const match = pickBestMatch(completions, trimmed);
  if (match.status !== 'resolved') {
    return match;
  }
  const { pxid } = match;

  // 3. Resolve the pxid → internal location id via POST /questionnaire/household
  //    (returns result.electricity_location.id). Etiquette: a minimum inter-
  //    request delay before the second live call (sequential, never parallel).
  //    Best-effort: a resolve without a location id is still useful, so null is
  //    a valid result.
  await delay(REQUEST_DELAY_MS);
  const locationId = await resolveLocationId(pxid, jar);

  // 4. Persist on the user row.
  await updatePowerswitchLocation(env.DB, userId, { pxid, locationId });

  console.log(JSON.stringify({
    type: 'powerswitch_address_resolved',
    userId,
    pxid,
    locationId,
    timestamp: new Date().toISOString(),
  }));

  return { status: 'resolved', pxid, locationId };
}

/**
 * Pick the best completion. Rules (issue #220):
 *   - 0 completions → needs_review (zero_match).
 *   - 1 completion  → resolved (exact / single).
 *   - >1 completions → if the user gave no unit AND a base (non-unit) address
 *     exists among the completions, pick it; else needs_review (ambiguous).
 */
export function pickBestMatch(
  completions: ReadonlyArray<PowerswitchCompletion>,
  userAddress: string
): ResolveAddressOutcome {
  if (completions.length === 0) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }
  if (completions.length === 1) {
    const only = completions[0]!;
    return { status: 'resolved', pxid: only.pxid, locationId: null };
  }

  // Multiple completions. If the user supplied a unit, we can't disambiguate
  // safely → manual review.
  if (addressHasUnit(userAddress)) {
    return { status: 'needs_review', reason: 'ambiguous', completions: completions.length };
  }

  // User gave no unit — prefer a base (non-unit) completion if one exists.
  const base = completions.find((c) => !addressHasUnit(c.a));
  if (base) {
    return { status: 'resolved', pxid: base.pxid, locationId: null };
  }
  return { status: 'needs_review', reason: 'ambiguous', completions: completions.length };
}

// ---------------------------------------------------------------------------
// Server-action POST helper (shared with the per-user replay)
// ---------------------------------------------------------------------------

/**
 * POST a Next.js server action. Body is a JSON array (text/plain); the response
 * is an RSC flight (text/x-component). Identified UA + the deployment-bound
 * action hash on every attempt. Sequential by construction (no Promise.all).
 * Captures Set-Cookie into the jar (the session is cookie-keyed).
 */
export async function postAction(
  url: string,
  bodyArray: unknown,
  actionHash: string,
  jar?: CookieJar
): Promise<string> {
  const body = JSON.stringify(bodyArray);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': POWERSWITCH_USER_AGENT,
        'Content-Type': 'text/plain;charset=UTF-8',
        Accept: 'text/x-component',
        'Next-Action': actionHash,
      };
      if (jar && jar.cookies.length > 0) {
        headers['Cookie'] = jar.cookies.join('; ');
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        // Server actions return 200 + flight, not a redirect. NOTE: workerd
        // does not implement redirect:'error' ("use manual and check the
        // status") — found live in the #242 test run; Node fetch accepts
        // 'error' so the smoke script masked it. 3xx is rejected below.
        redirect: 'manual',
        cf: { cacheTtl: 0 },
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`unexpected redirect HTTP ${response.status}`);
      }

      // Thread the session cookie through the chain.
      if (jar) {
        const setCookies =
          typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        for (const sc of setCookies) {
          const pair = sc.split(';')[0]!;
          const name = pair.split('=')[0]!.trim();
          jar.cookies = jar.cookies.filter((c) => !c.startsWith(name + '='));
          if (pair) jar.cookies.push(pair);
        }
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('POST failed after retries');
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

type CompletionsResult =
  | { readonly status: 'ok'; readonly completions: ReadonlyArray<PowerswitchCompletion> }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

/** previousData defaults for the household body (07-q-household.req.txt shape). */
const HOUSEHOLD_PREVIOUS_DATA = {
  address: '$undefined',
  icp: '$undefined',
  electricity_location: '$undefined',
  gas_location: '$undefined',
  electricity_retailer: '$undefined',
};

/**
 * Build the household server-action body for a pxid (07-q-household.req.txt).
 * Shared by the session (address→location) and the replay (full address + the
 * cookie-keyed session that the insulation/results POSTs depend on). ICP is
 * always `"$undefined"` — never submitted.
 */
export function householdRequestBody(pxid: string): unknown[] {
  return [
    {
      previousData: HOUSEHOLD_PREVIOUS_DATA,
      modifiedFields: { address_id: pxid, icp_identifier: '$undefined' },
    },
  ];
}

/**
 * POST the partial address to the autocomplete server-action and validate the
 * flight's completions row. Drift (missing/renamed shape) → typed failure.
 */
async function fetchCompletions(address: string, jar: CookieJar): Promise<CompletionsResult> {
  let flight: string;
  try {
    flight = await postAction(
      POWERSWITCH_BASE_URL + '/',
      [address], // 03-autocomplete.req.txt body: ["<address>"]
      AUTOCOMPLETE_ACTION,
      jar
    );
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : 'autocomplete fetch failed' };
  }

  const obj = findFlightObject(flight, 'completions');
  if (!obj) {
    logDrift('no completions row in autocomplete flight', flight);
    return { status: 'drift', reason: 'missing_completions_row' };
  }
  return validateCompletions(obj);
}

/**
 * Validate the autocomplete completion object. Drift (missing/non-array
 * `completions`, or a malformed entry) → structured error + typed failure.
 */
export function validateCompletions(body: unknown): CompletionsResult {
  if (body === null || typeof body !== 'object') {
    logDrift('response is not an object', body);
    return { status: 'drift', reason: 'non_object_response' };
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.completions)) {
    logDrift('missing or non-array `completions` field', body);
    return { status: 'drift', reason: 'missing_completions_array' };
  }

  const completions: PowerswitchCompletion[] = [];
  for (const entry of obj.completions) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).a === 'string' &&
      typeof (entry as Record<string, unknown>).pxid === 'string' &&
      typeof (entry as Record<string, unknown>).v === 'number'
    ) {
      const e = entry as { a: string; pxid: string; v: number };
      completions.push({ a: e.a, pxid: e.pxid, v: e.v });
    } else {
      logDrift('completion entry has wrong shape', entry);
      return { status: 'drift', reason: 'malformed_completion_entry' };
    }
  }
  return { status: 'ok', completions };
}

/**
 * Resolve a pxid to the internal location id via POST /questionnaire/household
 * (07-q-household.res.txt: result.electricity_location.id = 267). Returns null
 * if the flight lacks the location (a resolve is still useful without it).
 */
async function resolveLocationId(pxid: string, jar: CookieJar): Promise<string | null> {
  try {
    const flight = await postAction(
      `${POWERSWITCH_BASE_URL}/questionnaire/household?address_id=${encodeURIComponent(pxid)}`,
      householdRequestBody(pxid),
      HOUSEHOLD_ACTION,
      jar
    );
    const obj = findFlightObject(flight, 'result');
    if (!obj) return null;
    const result = obj.result;
    if (result === null || typeof result !== 'object') return null;
    const loc = (result as Record<string, unknown>).electricity_location;
    if (loc === null || typeof loc !== 'object') return null;
    const id = (loc as Record<string, unknown>).id;
    return typeof id === 'number' ? String(id) : null;
  } catch (error) {
    console.log(JSON.stringify({
      type: 'powerswitch_location_resolve_failed',
      pxid,
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an address string carries a unit-level prefix. NZ unit conventions:
 *   - "12A ..." / "1/12 ..." (unit/number), or a leading letter then number.
 * A bare street number like "1 Queen Street" has NO unit. Heuristic only —
 * used to decide whether to auto-pick a base address.
 */
export function addressHasUnit(address: string): boolean {
  const trimmed = address.trim();
  if (/^\d+\s*\/\s*\d+/.test(trimmed)) return true; // "1/12 ..."
  if (/^\d+[A-Za-z]\b/.test(trimmed)) return true; // "12A ..."
  if (/^(unit|flat|apartment|apt|u|f)\s+\w+\b/i.test(trimmed)) return true; // "Unit 3 ..."
  return false;
}

function logDrift(detail: string, sample: unknown): void {
  console.error(JSON.stringify({
    type: 'powerswitch_drift',
    detail,
    sample: truncate(JSON.stringify(sample)),
    timestamp: new Date().toISOString(),
  }));
}

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
