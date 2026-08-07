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
 *
 * ADDRESS TOLERANCE (issue #278): the address text comes from parsed bills, so
 * it is noisy (label prefixes, glued ICP, newlines, unit prefixes, missing
 * suburbs/postcodes). Resolution is now a two-stage pipeline:
 *   1. QUERY LADDER — `sanitiseAddress` does one normalisation pass (whitespace,
 *      label/ICP/country stripping), then `addressQueryVariants` builds up to 4
 *      faithful-to-loose query strings. `resolveUserAddress` tries them in
 *      order, one live POST each, stopping at the first non-empty completion
 *      set. This recovers the cases that previously returned zero completions
 *      (newlines, glued ICP, unit prefix hiding the street).
 *   2. MATCH SCORING — `pickBestMatch` scores every completion via
 *      `scoreCompletion` (postcode-anchored; street name + number are hard
 *      rejects). This kills the silent-wrong picks (a different street/city)
 *      and recovers the postcode-typo and unit-only (location-equivalent)
 *      cases. Powerswitch prices by network location, so any unit at the same
 *      street number + postcode yields the correct plans — a unit-only tie is
 *      resolved, not reviewed.
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

  const sanitised = sanitiseAddress(address);
  if (!sanitised) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }

  const jar = createCookieJar();

  // 1. Query ladder (issue #278): sanitise → variants → first variant that
  //    RESOLVES. Each variant is one live POST to the autocomplete server-
  //    action, tried in order (most faithful first). A drift/error aborts the
  //    ladder at once — do not retry a drifted endpoint with a different query.
  //    The match always runs against the SANITISED FULL address; the variant is
  //    only how we asked the question.
  //
  //    Advancing on "no resolvable match" rather than "no completions at all"
  //    is load-bearing: a unit prefix makes Addressfinder return a non-empty
  //    set of the WRONG street ("Flat 2, 14 Wallace Street" → six completions,
  //    none on Wallace Street), which the scoring rejects wholesale. Stopping
  //    at the first non-empty set would strand that address in manual review
  //    even though the unit-stripped variant matches it exactly.
  const variants = addressQueryVariants(sanitised);
  let match: ResolveAddressOutcome | null = null;
  let winningVariant = -1;
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await delay(REQUEST_DELAY_MS); // etiquette BETWEEN attempts
    const outcome = await fetchCompletions(variants[i]!, jar);
    if (outcome.status === 'drift') return { status: 'drift', reason: outcome.reason };
    if (outcome.status === 'error') return { status: 'error', reason: outcome.reason };
    if (outcome.completions.length === 0) continue;

    const attempt = pickBestMatch(outcome.completions, sanitised);
    // Keep the FIRST non-empty variant's outcome as the reported fallback, so a
    // ladder that never resolves still reports the most faithful query's counts.
    if (match === null) match = attempt;
    if (attempt.status === 'resolved') {
      match = attempt;
      winningVariant = i;
      break;
    }
  }
  if (match === null) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }
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
    variant: winningVariant,
    timestamp: new Date().toISOString(),
  }));

  return { status: 'resolved', pxid, locationId };
}

/** Common NZ street-suffix abbreviations, expanded for comparison only. */
const STREET_ABBREVIATIONS: Record<string, string> = {
  rd: 'road', st: 'street', ave: 'avenue', av: 'avenue', dr: 'drive',
  cres: 'crescent', tce: 'terrace', pl: 'place', ln: 'lane', hwy: 'highway',
  mt: 'mount', esp: 'esplanade', pde: 'parade', sq: 'square', gr: 'grove',
};

/** Street-type tokens (abbrev keys + expanded values) for finding the name/type boundary. */
const STREET_TYPE_WORDS = new Set<string>([
  ...Object.keys(STREET_ABBREVIATIONS),
  ...Object.values(STREET_ABBREVIATIONS),
]);

/** Lowercase + expand abbreviations. Used for equality comparison of a street name or locality. */
function normaliseStreetName(name: string): string {
  // Fold diacritics (NFD, drop combining marks) so macron-stripped bill text
  // ("Tuwharetoa") compares equal to macronised Addressfinder records
  // ("Tūwharetoa") — NZ bills routinely strip macrons. Both sides go through
  // this, so folding is equality-preserving and never reaches the live query
  // (sanitiseAddress keeps macrons intact; Addressfinder indexes them). (#278)
  const s = foldDiacritics(name.toLowerCase().replace(/[.,]/g, ' ')).replace(/\s+/g, ' ').trim();
  return s.split(' ').map((w) => STREET_ABBREVIATIONS[w] ?? w).join(' ');
}

/**
 * Normalise an address for equality comparison ONLY (never persisted, never
 * submitted): lowercase, punctuation → spaces, "1/82 X" and "Unit 1, 82 X"
 * unified, street abbreviations expanded. Both sides of the comparison go
 * through this, so a semantically wrong expansion (e.g. "St Heliers" →
 * "street heliers") is still equality-preserving.
 */
export function normaliseAddressForMatch(address: string): string {
  let a = address.toLowerCase().replace(/[.,]/g, ' ');
  a = a.replace(/^(\d+[a-z]?)\s*\/\s*(\d+)/, 'unit $1 $2'); // "1/82 X" → "unit 1 82 X"
  a = a.replace(/^(?:unit|flat|apartment|apt|u|f)\s+(\w+)\b/, 'unit $1');
  a = a.replace(/\s+/g, ' ').trim();
  return a
    .split(' ')
    .map((w) => STREET_ABBREVIATIONS[w] ?? w)
    .join(' ');
}

/**
 * One normalisation pass applied before any autocomplete query (issue #278).
 * Pure & idempotent. Order: collapse whitespace; strip a leading label prefix
 * ("Supply Address:"); strip a trailing glued ICP token; strip a trailing
 * country suffix; trim trailing commas/semicolons. Macrons are NOT folded here
 * (Addressfinder indexes them) — folding is a query-variant, not a sanitise step.
 */
export function sanitiseAddress(raw: string): string {
  let a = raw.replace(/\s+/g, ' ').trim();
  a = a.replace(/^(?:(?:supply|service|installation|property|site)\s+)?address\s*:\s*/i, '');
  a = a.replace(/\s+icp:?\s*[a-z0-9]{10,}$/i, '');
  a = a.replace(/,?\s*(?:new zealand|nz|aotearoa)\s*$/i, '');
  return a.replace(/[,\s;]+$/, '').trim();
}

/** Strip a leading unit prefix ("Unit 5, "/"Flat 2, "/"1/82 …"); null if none.
 *  For the slash form "1/82", the trailing number is the STREET number — keep it. */
function stripUnitPrefix(s: string): string | null {
  const slash = s.match(/^(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)\b/i);
  if (slash) {
    const kept = `${slash[2]} ${s.slice(slash[0].length).trim()}`.trim();
    return kept || null;
  }
  const word = s.match(/^(?:unit|flat|apartment|apt|level)\s+([0-9a-z]+)\b[,\s]*/i);
  if (word) {
    const rest = s.slice(word[0].length).trim();
    return rest || null;
  }
  return null;
}

/** Remove a standalone "RD N"/"R.D. N" comma segment; returns the input if there is none. */
function stripRdSegment(s: string): string {
  const segs = s.split(',').map((x) => x.trim()).filter((seg) => !/^(?:rd|r\.d\.)\s*\d+$/i.test(seg));
  return segs.join(', ').trim();
}

/** Fold diacritics (NFD, drop combining marks) — macrons etc. */
function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** The first comma segment that begins with a street number (skips a leading unit segment). */
function streetSegmentOf(s: string): string | null {
  const segs = s.split(',').map((x) => x.trim()).filter(Boolean);
  return segs.find((seg) => /^\d+[a-z]?\b/i.test(seg)) ?? null;
}

/** Maximum autocomplete queries the ladder issues (one live POST each; shared-resource etiquette). */
const MAX_QUERY_VARIANTS = 4;

/**
 * Ordered autocomplete query strings to try, most faithful first (issue #278).
 * Deduped, no empties, capped at MAX_QUERY_VARIANTS. Each entry is one live POST.
 *   1. sanitised as-is
 *   2. unit prefix removed ("Flat 2, 14 Wallace St" → "14 Wallace St")
 *   3. RD segment removed
 *   4. diacritics folded (macrons → ASCII)
 *   5. street + postcode only
 *   6. street + city, postcode dropped
 */
export function addressQueryVariants(sanitised: string): string[] {
  const base = sanitised.trim();
  const out: string[] = [];
  const push = (v: string | null): void => {
    const t = (v ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };

  push(base);
  push(stripUnitPrefix(base));
  const noRd = stripRdSegment(base);
  push(noRd === base ? null : noRd);
  const folded = foldDiacritics(base);
  push(folded === base ? null : folded);
  const street = streetSegmentOf(base);
  const pc = base.match(/(\d{4})\s*$/);
  if (street && pc) push(`${street} ${pc[1]!}`);
  const segs = base.split(',').map((x) => x.trim()).filter(Boolean);
  if (street && segs.length >= 2) {
    const city = segs[segs.length - 1]!.replace(/\s+\d{4}\s*$/, '').trim();
    if (city) push(`${street} ${city}`);
  }

  return out.slice(0, MAX_QUERY_VARIANTS);
}

/** Parsed components of an address string (user side or a completion). */
export interface AddressParts {
  readonly unit: string | null;
  readonly number: string | null;
  readonly numberBase: number | null;
  readonly streetName: string | null;
  readonly suburb: string | null;
  readonly city: string | null;
  readonly postcode: string | null;
}

/** Leading word-unit prefix ("Unit 5, "/"Suite 1, "), capturing the unit value.
 *  `level` is included because "Level N" is an NZ unit/floor prefix; it collapses
 *  to the same bare unit value as "Floor N" (both denote the same door class). */
const UNIT_WORD_RE = /^(?:unit|flat|apartment|apt|floor|shop|suite|level)\s+([0-9a-z]+)\b[,\s]*/i;

/**
 * Parse an address into components for scoring. Best-effort & lenient — missing
 * fields are null. The street name ends at the LAST street-type word in the
 * street segment (so "Mount Eden Road" → "mount eden road", and a no-comma
 * "Queen Street Auckland Central" still yields street name "queen street").
 */
export function parseAddressParts(raw: string): AddressParts {
  const parts: {
    unit: string | null; number: string | null; numberBase: number | null;
    streetName: string | null; suburb: string | null; city: string | null; postcode: string | null;
  } = {
    unit: null, number: null, numberBase: null,
    streetName: null, suburb: null, city: null, postcode: null,
  };
  let a = raw.replace(/\s+/g, ' ').trim();
  if (!a) return parts;

  const pc = a.match(/(\d{4})\s*$/); // trailing 4-digit postcode
  if (pc) {
    parts.postcode = pc[1]!;
    a = a.slice(0, pc.index ?? 0).replace(/[,\s]+$/, '').trim();
  }

  const segments = a.split(',').map((s) => s.trim()).filter(Boolean);

  // Unit: slash form "1/82 …" then any leading word-unit segments.
  let unitVal: string | null = null;
  const first = segments[0];
  if (first) {
    const slash = first.match(/^(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)\b/i);
    if (slash) {
      unitVal = slash[1]!.toLowerCase(); // "1" of "1/82"
      // The trailing number is the street number — keep it as the segment head.
      segments[0] = `${slash[2]} ${first.slice(slash[0].length).trim()}`.trim();
    }
  }
  while (segments.length > 0) {
    const m = segments[0]!.match(UNIT_WORD_RE);
    if (!m) break;
    if (unitVal === null) unitVal = m[1]!.toLowerCase();
    segments[0] = segments[0]!.slice(m[0].length).trim();
    if (segments[0] === '') segments.shift();
  }
  parts.unit = unitVal;

  // Street segment: leading number (incl. "82A"/"1-5"), then name up to the
  // last street-type word; anything after the type word is locality head.
  if (segments.length > 0) {
    const seg = segments.shift()!;
    const num = seg.match(/^(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\b/i);
    let rest = seg;
    if (num) {
      parts.number = num[1]!.replace(/\s+/g, '');
      parts.numberBase = parseInt(parts.number, 10);
      rest = seg.slice(num[0].length);
    }
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    let typeIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (STREET_TYPE_WORDS.has(tokens[i]!.toLowerCase())) typeIdx = i;
    }
    const nameTokens = typeIdx >= 0 ? tokens.slice(0, typeIdx + 1) : tokens;
    const localityHead = typeIdx >= 0 ? tokens.slice(typeIdx + 1) : [];
    parts.streetName = normaliseStreetName(nameTokens.join(' ')) || null;
    if (localityHead.length > 0) segments.unshift(localityHead.join(' '));
  }

  // Locality: 1 segment → city; ≥2 → suburb = all but last, city = last.
  if (segments.length === 1) {
    parts.city = normaliseStreetName(segments[0]!) || null;
  } else if (segments.length >= 2) {
    parts.suburb = normaliseStreetName(segments.slice(0, -1).join(' ')) || null;
    parts.city = normaliseStreetName(segments[segments.length - 1]!) || null;
  }
  return parts;
}

/**
 * Match "PO Box" / "P.O. Box" / "POBox" (case-insensitive, optional dots and
 * spaces). A PO Box is a postal facility, not a metered electricity supply
 * address — resolving one would hand the user plans for the wrong location
 * entirely, so it is always a hard reject. (#278)
 */
const PO_BOX_RE = /\bp\.?o\.?\s*box\b/i;
function isPoBox(s: string): boolean {
  return PO_BOX_RE.test(s);
}

/**
 * Score a candidate completion against the user's address. Returns null for a
 * hard reject (a PO Box on either side, different street, different number, or a
 * postcode mismatch the suburb cannot redeem), else a score where higher is
 * better. Postcode-anchored — the postcode is what drives plan accuracy. A
 * postcode mismatch WITH an agreeing suburb is tolerated (a user typo, e.g.
 * "1011" for "1010").
 */
export function scoreCompletion(userAddress: string, candidate: string): number | null {
  // A PO Box is never a metered supply address — reject either side outright.
  if (isPoBox(userAddress) || isPoBox(candidate)) return null;

  const u = parseAddressParts(userAddress);
  const c = parseAddressParts(candidate);

  if (u.streetName && c.streetName && u.streetName !== c.streetName) return null;
  if (u.numberBase !== null && c.numberBase !== null && u.numberBase !== c.numberBase) return null;
  if (u.postcode && c.postcode && u.postcode !== c.postcode) {
    if (!u.suburb || !c.suburb || u.suburb !== c.suburb) return null;
  }

  let score = 0;
  if (u.postcode && c.postcode && u.postcode === c.postcode) score += 100;
  if (u.suburb && c.suburb && u.suburb === c.suburb) score += 40;
  if (u.unit === c.unit) score += 30; // both null counts as equal
  // An exact street-number match AS WRITTEN (including the letter on "82A") is
  // strong evidence. The bonus clears RESOLVE_MARGIN so an exact lettered number
  // wins outright over its bare neighbours — regression: a real Meridian bill's
  // "82A Verran Rd" was wrongly sent to manual review when it only led by +10.
  if (u.number && c.number && u.number === c.number) score += 50;
  if (u.unit === null && c.unit === null) score += 5;
  return score;
}

/** Whether two completions are the same door differing only by unit. */
function locationEquivalent(a: PowerswitchCompletion, b: PowerswitchCompletion): boolean {
  const pa = parseAddressParts(a.a);
  const pb = parseAddressParts(b.a);
  return (
    pa.number === pb.number &&
    pa.streetName === pb.streetName &&
    pa.postcode === pb.postcode &&
    pa.suburb === pb.suburb &&
    pa.city === pb.city
  );
}

/** Score gap at which the best completion resolves outright over the runner-up. */
const RESOLVE_MARGIN = 20;

/**
 * Pick the best completion via postcode-anchored scoring (issue #278). The user
 * address is sanitised first; every completion is scored and hard rejects (a
 * different street/number, or an unredeemed postcode mismatch) are dropped. A
 * clear winner resolves; a tie among units at the same street number + postcode
 * resolves too (Powerswitch prices by network location); anything genuinely
 * ambiguous goes to manual review.
 */
export function pickBestMatch(
  completions: ReadonlyArray<PowerswitchCompletion>,
  userAddress: string
): ResolveAddressOutcome {
  if (completions.length === 0) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }
  const user = sanitiseAddress(userAddress);

  const scored: Array<{ c: PowerswitchCompletion; s: number }> = [];
  for (const c of completions) {
    const s = scoreCompletion(user, c.a);
    if (s !== null) scored.push({ c, s });
  }
  if (scored.length === 0) {
    return { status: 'needs_review', reason: 'zero_match', completions: completions.length };
  }
  if (scored.length === 1) {
    return { status: 'resolved', pxid: scored[0]!.c.pxid, locationId: null };
  }

  scored.sort((a, b) => b.s - a.s);
  const best = scored[0]!;
  const runnerUp = scored[1]!;
  if (best.s - runnerUp.s >= RESOLVE_MARGIN) {
    return { status: 'resolved', pxid: best.c.pxid, locationId: null };
  }

  // Top scores within the margin: if every tied candidate is the same door
  // differing only by unit, resolve the first (location-equivalent; E-chch).
  const topScore = best.s;
  const tied = scored.filter((x) => x.s === topScore);
  if (tied.length > 1 && tied.every((x) => locationEquivalent(x.c, best.c))) {
    const chosen = tied[0]!.c;
    console.log(JSON.stringify({
      type: 'powerswitch_address_location_equivalent',
      unitCount: tied.length,
      chosen: chosen.a,
    }));
    return { status: 'resolved', pxid: chosen.pxid, locationId: null };
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
