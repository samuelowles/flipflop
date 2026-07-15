/**
 * #220 — Powerswitch per-user address resolution.
 *
 * Given a user's NZ address string, resolve it to a Powerswitch `pxid`
 * (Addressfinder-backed address id) and internal location id. The pair is
 * persisted on the user row (migration 0018) so #221 can replay the
 * questionnaire per user without re-resolving the address every time.
 *
 * COMPLIANCE (docs/POWERSWITCH_COMPLIANCE.md, issue #219 — the authority):
 *   - LIVE per-user calls are GATED behind `env.POWERSWITCH_LIVE === 'true'`.
 *     With the flag unset/false this module is INERT: it makes no live calls,
 *     logs `powerswitch_live_disabled`, and returns a `disabled` outcome.
 *     Tests use FIXTURES only (no live calls ever run in CI).
 *   - ICP is NEVER submitted. No code path here reads, constructs, or posts an
 *     ICP value. The questionnaire's optional ICP step is always skipped;
 *     results are complete without it (verified 2026-07-15).
 *   - Sequential requests with delay + exponential backoff (shared-resource
 *     etiquette; mirrors services/powerswitchScraper.ts).
 *   - Identified user agent on every request (no browser-UA spoofing).
 *   - Drift handling: if the autocomplete response lacks the expected
 *     `completions` shape (Powerswitch redeploy churn), emit a distinct
 *     `console.error('powerswitch_drift', {...})` and return a typed `drift`
 *     failure — never silently persist a partial/garbage guess.
 *
 * Match confidence:
 *   - exact / single completion → auto-accept.
 *   - zero completions          → needs_review (no bad guess persisted).
 *   - multiple completions       → if the user gave no unit AND a base
 *     (non-unit-level) completion exists, pick the base address; otherwise
 *     flag for manual review (reuses the `needs_review` status convention
 *     from bill parsing).
 */

import { updatePowerswitchLocation } from '../models/users';

/** Base URL. Public site; no auth. */
export const POWERSWITCH_BASE_URL = 'https://www.powerswitch.org.nz';

/**
 * Identified user agent. Same string used by services/powerswitchScraper.ts so
 * Powerswitch sees one consistent Flip identity across both surfaces.
 */
export const POWERSWITCH_USER_AGENT =
  'FlipNZ-BillMonitor/1.0 (+https://flip.nz; issue #220; contact: ops@flip.nz)';

/** Etiquette constants — conservative; Powerswitch is a shared not-for-profit resource. */
const REQUEST_DELAY_MS = 1500; // delay between the autocomplete + questionnaire calls
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

/** Env shape this module needs. KV is unused now but reserved for #221's results cache. */
export interface PowerswitchSessionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  /** #219/#220: gate that keeps the per-user bridge INERT. Defaults false. */
  readonly POWERSWITCH_LIVE?: string;
}

/** Expected autocomplete completion entry shape. */
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
 * `drift` to the manual-review path. Never persists a guess.
 *
 * ICP is never submitted at any point in this flow.
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

  // 1. Autocomplete — POST to the site root (Next.js server-action).
  const completionOutcome = await fetchCompletions(trimmed);
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

  // 3. Resolve the pxid → internal location id via the questionnaire redirect.
  //    Etiquette: a minimum inter-request delay before the second live call
  //    (sequential, never parallel). Best-effort: a resolve without a location
  //    id is still useful (#221 can re-request it), so null is a valid result.
  await delay(REQUEST_DELAY_MS);
  const locationId = await resolveLocationId(pxid);

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
// Fetch helpers
// ---------------------------------------------------------------------------

type CompletionsResult =
  | { readonly status: 'ok'; readonly completions: ReadonlyArray<PowerswitchCompletion> }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

/**
 * POST the partial address to the Powerswitch autocomplete server-action.
 * Validates the response shape; on drift emits a structured error and returns
 * a typed failure rather than persisting garbage.
 */
async function fetchCompletions(address: string): Promise<CompletionsResult> {
  let body: unknown;
  try {
    const response = await postWithBackoff(
      POWERSWITCH_BASE_URL + '/',
      // Next.js server-action form body. The action id rotates per deploy; we
      // send the address under the field the action reads. The compliance gate
      // (#221) owns discovering the live action id; against fixtures the test
      // stubs fetch and ignores the body shape.
      new URLSearchParams({ address }),
      { 'Next-Action': 'autocomplete' }
    );
    body = response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'autocomplete fetch failed';
    return { status: 'error', reason };
  }

  return validateCompletions(body);
}

/**
 * Validate the autocomplete response shape. Drift (missing/renamed `completions`
 * array) → structured error log + typed failure. Never throws.
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
 * Resolve a pxid to the internal location id via the questionnaire redirect.
 * GET /questionnaire/household?address_id={pxid} redirects to
 * /questionnaire/{locationId}/... — we extract the first integer path segment.
 * Returns null if it can't be parsed (resolve is still useful without it).
 */
async function resolveLocationId(pxid: string): Promise<string | null> {
  try {
    const url = `${POWERSWITCH_BASE_URL}/questionnaire/household?address_id=${encodeURIComponent(pxid)}`;
    const location = await getLocationHeaderWithBackoff(url);
    if (!location) return null;
    const match = location.match(/\/questionnaire\/(\d+)\b/);
    return match?.[1] ?? null;
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

/**
 * POST with retry + backoff. Returns parsed JSON. Identified user agent on
 * every attempt. Sequential by construction (no Promise.all anywhere here).
 */
async function postWithBackoff(
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
        redirect: 'error', // we don't expect a redirect on the server-action
        cf: { cacheTtl: 0 },
      });
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('POST failed after retries');
}

/**
 * GET the Location header from the questionnaire redirect (manual redirect,
 * so we capture the header rather than follow it). Retries on transient errors.
 */
async function getLocationHeaderWithBackoff(url: string): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': POWERSWITCH_USER_AGENT,
          Accept: 'text/html',
        },
        redirect: 'manual', // capture the Location header, don't follow
        cf: { cacheTtl: 0 },
      });
      // A manual redirect surfaces as a 3xx with a Location header.
      const location = response.headers.get('Location') ?? response.headers.get('location');
      if (location) return location;
      // Some deploys may return 200 with the id in the body path; tolerate null.
      return null;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('GET location header failed after retries');
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
 * A bare street number like "1 Queen Street" or "12 Birkdale Road" has NO unit.
 * Heuristic only — used to decide whether to auto-pick a base address.
 */
export function addressHasUnit(address: string): boolean {
  const trimmed = address.trim();
  // "1/12 ..." — slash-separated unit prefix.
  if (/^\d+\s*\/\s*\d+/.test(trimmed)) return true;
  // "12A ..." — number immediately followed by a letter.
  if (/^\d+[A-Za-z]\b/.test(trimmed)) return true;
  // "Unit 3", "Flat 2", "Apartment 12", "U 3" prefixes.
  if (/^(unit|flat|apartment|apt|u|f)\s+\w+\b/i.test(trimmed)) return true;
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
