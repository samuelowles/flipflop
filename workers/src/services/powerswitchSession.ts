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
 * ADDRESS RESOLUTION POLICY (issue #279 — inverted from #278): the address
 * text comes from parsed bills, so it is noisy (label prefixes, glued ICP,
 * newlines, unit prefixes, missing suburbs/postcodes). Resolution ALWAYS picks
 * the closest available completion and never sends a non-empty result to manual
 * review. Two facts justify substituting a neighbouring address for the one the
 * user entered:
 *   - Plans are a function of POSTCODE, not street address. Live measurement
 *     shows different addresses sharing a postcode return the identical
 *     Powerswitch electricity_location (1010 → 267 for Queen/Albert/Emily;
 *     6021 → 386 for Wallace/Bidwill; 0626 → 268 for Verran/Salisbury). So a
 *     same-postcode substitution yields identical plans and is harmless.
 *   - There is no human review path. `needs_review` degraded users to generic
 *     seeded plans rather than their real ones; the owner eliminated that.
 * The pipeline:
 *   1. QUERY LADDER — `sanitiseAddress` does one normalisation pass (whitespace,
 *      label/ICP/country stripping), then `addressQueryVariants` builds up to 4
 *      faithful-to-loose query strings. `resolveUserAddress` iterates them in
 *      order, one live POST each, and HUNTS for an `exact`/`postcode`-tier
 *      resolution (postcode agreement). The first variant that yields one wins
 *      and stops the ladder; if none ever does, the FIRST variant's pick is
 *      kept (an earlier, more faithful query beats a later, looser one). When
 *      the user's own address has no postcode, no variant can reach a postcode
 *      tier, so the ladder stops at the first non-empty set rather than
 *      spending calls it cannot use. Only an address whose every variant
 *      returns zero completions ends in `needs_review`.
 *   2. MATCH SCORING — `pickBestMatch` ranks every completion via
 *      `scoreCompletion` (postcode-anchored; postcode agreement dominates every
 *      other signal combined) and resolves to the top-ranked one. The resolved
 *     outcome carries a `confidence` tier: `exact` (street + numberBase +
 *     postcode all agree), `postcode` (postcode agrees, street/number do not),
 *     `crossed` (both postcodes known and DIFFERENT — we knowingly picked
 *     another network area), or `unverified` (a postcode missing on one side,
 *     so nothing could be checked). The last two are counted SEPARATELY via
 *     `console.warn`, because a known divergence and an unverifiable pick are
 *     different failure modes and burying one in the other would make the
 *     accepted risk of this policy unmeasurable.
 *   The parsing work in `parseAddressParts` (directional suffixes, route
 *   numbers, the mount/mt boundary rule, the stray-comma fold) is unchanged —
 *   it now drives ranking quality instead of rejection, and is still
 *   load-bearing.
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

/**
 * Confidence tier of a resolved address (issue #279). Drives observability.
 *
 * The two lower tiers are SEPARATE because they are different failure modes:
 *   - `crossed`    — both postcodes known and DIFFERENT. We knowingly picked
 *     another postcode, so the postcode→location invariant does NOT hold.
 *   - `unverified` — a postcode is missing on one or both sides, so there was
 *     nothing to check.
 *
 * DO NOT read `crossed` as "the risky tier" and `unverified` as "the benign
 * one" — measured against the captured corpora it is close to the opposite.
 * Both resolutions that genuinely land in the wrong network (`G-street-only`
 * "Queen Street" → Waihi 3610; `M-city-only` → a different Wellington postcode)
 * are `unverified`, while one of the two `crossed` entries is a postcode typo
 * that resolved to the CORRECT door. The risk concentrates where the user's
 * postcode is missing, which is precisely the condition that forces the
 * `unverified` label.
 *
 * That is why the warn payload carries `cityMatch` rather than the tier alone:
 * the tier says how much evidence we had, `cityMatch` says whether what
 * evidence there was agreed. Alert on `cityMatch` != 'agrees', not on tier.
 */
export type ResolveConfidence = 'exact' | 'postcode' | 'crossed' | 'unverified';

/** Discriminated outcome of a resolve attempt. Callers route on `status`. */
export type ResolveAddressOutcome =
  | { readonly status: 'resolved'; readonly pxid: string; readonly locationId: string | null; readonly confidence: ResolveConfidence }
  | { readonly status: 'needs_review'; readonly reason: 'zero_match'; readonly completions: number }
  | { readonly status: 'drift'; readonly reason: string }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly reason: string };

/** Whether the per-user bridge is armed. Ships false; flip via wrangler secret. */
export function isPowerswitchLive(env: PowerswitchSessionEnv): boolean {
  return env.POWERSWITCH_LIVE === 'true';
}

/**
 * Resolve a user's address string to a pxid (+ location id) and persist both
 * on the user row (issue #279). ALWAYS resolves to the closest available
 * completion when any variant returns one — never sends a non-empty result to
 * review. The resolved `confidence` tier tells callers how trustworthy the
 * postcode match is (`exact`/`postcode` keep the postcode→location invariant;
 * `crossed`/`unverified` may not, and are warned on). Only a
 * zero-completion ladder, a drift, or an error short of resolving yields a
 * non-resolved outcome. ICP is never submitted. One cookie-keyed session
 * threads autocomplete → household.
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
  // PO Box short-circuit. This survives the #279 always-resolve policy for a
  // specific reason: a PO Box postcode is a POSTAL-FACILITY range, not a
  // physical distribution-network area. The postcode→location invariant that
  // justifies substituting a neighbouring address (same postcode → same
  // electricity_location → same plans) does NOT hold for postal postcodes, so
  // resolving a PO Box to a neighbouring postal box would price the wrong
  // network entirely. We know up front it can never resolve to a metered
  // supply, so short-circuit before any live request — don't spend one of
  // Powerswitch's shared-resource calls to learn what we know.
  if (isPoBox(sanitised)) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }

  const jar = createCookieJar();

  // 1. Query ladder (issue #279): iterate ALL variants in order (most faithful
  //    first), one live POST each, and HUNT for a postcode-tier resolution.
  //    The match always runs against the SANITISED FULL address; the variant is
  //    only how we asked the question. A drift/error aborts the ladder at once
  //    — do not retry a drifted endpoint with a different query.
  //
  //    For each variant with a non-empty completion set, rank the completions:
  //      - confidence `exact` or `postcode` → take it and STOP. Postcode
  //        agreement is what keeps the postcode→location invariant intact, so a
  //        postcode-tier hit is terminal and the best we can do.
  //      - `crossed`/`unverified` → keep it as best-so-far ONLY if it is the
  //        first one seen, then continue. An earlier, more faithful query's
  //        pick beats a later, looser one's, so a later pick never overrides an
  //        earlier one.
  //    After all variants, resolve using best-so-far. If no variant ever
  //    returned a completion, the address is genuinely unresolvable.
  //
  //    SHORT-CIRCUIT: when the user's own address carries no postcode, no
  //    candidate can ever reach `exact`/`postcode` (confidenceTier returns
  //    `unverified` on a missing user postcode regardless of the candidate), so
  //    every later variant would be fetched, ranked and discarded. Stop at the
  //    first non-empty set instead — same reasoning as the PO Box short-circuit
  //    above: don't spend a shared-resource call to learn what we already know.
  const userHasPostcode = parseAddressParts(sanitised).postcode !== null;
  const variants = addressQueryVariants(sanitised);
  let best: { pxid: string; confidence: ResolveConfidence; chosenAddress: string; variant: number } | null = null;
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await delay(REQUEST_DELAY_MS); // etiquette BETWEEN attempts
    const outcome = await fetchCompletions(variants[i]!, jar);
    if (outcome.status === 'drift') return { status: 'drift', reason: outcome.reason };
    if (outcome.status === 'error') return { status: 'error', reason: outcome.reason };
    if (outcome.completions.length === 0) continue;

    const { completion, confidence } = rankAndPick(outcome.completions, sanitised);
    if (best === null) {
      best = { pxid: completion.pxid, confidence, chosenAddress: completion.a, variant: i };
    }
    if (confidence === 'exact' || confidence === 'postcode') {
      best = { pxid: completion.pxid, confidence, chosenAddress: completion.a, variant: i };
      break;
    }
    if (!userHasPostcode) break; // nothing later can improve on this
  }
  if (best === null) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }
  const { pxid, variant, confidence, chosenAddress } = best;

  // 3. Resolve the pxid → internal location id via POST /questionnaire/household
  //    (returns result.electricity_location.id). Etiquette: a minimum inter-
  //    request delay before the second live call (sequential, never parallel).
  //    Best-effort: a resolve without a location id is still useful, so null is
  //    a valid result.
  await delay(REQUEST_DELAY_MS);
  const locationId = await resolveLocationId(pxid, jar);

  // 4. Persist on the user row. Writes only powerswitch_pxid +
  //    powerswitch_location_id — NEVER installation_address (the bill's address
  //    is the source of truth; a substituted completion must not overwrite it).
  await updatePowerswitchLocation(env.DB, userId, { pxid, locationId });

  // NOTE: the chosen STREET address is deliberately absent from this line.
  // `installation_address` is encrypted at rest, docs/AI_RULES.md says "no user
  // data in logs", and docs/POWERSWITCH_COMPLIANCE.md commits to Powerswitch in
  // a partner-facing table that server logs are "redacted of address/PII".
  // Logging a full address next to `userId` would create a plaintext
  // userId→address pair in the log sink and partly defeat that encryption.
  // Locality (postcode/suburb/city) is what measurement actually needs, and it
  // carries no street-level identifier.
  const userParts = parseAddressParts(sanitised);
  const chosenParts = parseAddressParts(chosenAddress);

  console.log(JSON.stringify({
    type: 'powerswitch_address_resolved',
    userId,
    pxid,
    locationId,
    confidence,
    chosenPostcode: chosenParts.postcode,
    variant,
    timestamp: new Date().toISOString(),
  }));

  // A sub-postcode resolution may return plans for the wrong network area. That
  // cost was accepted by the owner on the condition it be MEASURABLE, never
  // silent — so warn (not log). `console.warn` is permitted by the eslint config.
  //
  // `cityMatch` is what makes `unverified` triageable, and it is load-bearing:
  // the risk concentrates exactly where the user's postcode is MISSING, which is
  // the condition that forces the `unverified` label — so without a locality
  // signal, a shift from "no postcode, resolved correctly" to "no postcode,
  // resolved to another region" would produce identical log lines and move no
  // counter. `unknown` (no city on either side) is the highest-risk state: no
  // locality evidence at all.
  //
  // ALERTING: `cityMatch != 'agrees'` catches two of the three wrong-network
  // shapes seen in the corpora. It does NOT catch the third — same city,
  // different suburb, different postcode ("25 Riddiford Street, Wellington"
  // resolving to "25 Buckingham Street, Melrose, Wellington 6023"), which
  // reports `agrees` because both are Wellington. That shape IS detectable from
  // this payload: the records where `userSuburb` is null or differs from
  // `chosenSuburb`. Run that as a second query — it is not folded into
  // `cityMatch` because a null user suburb may be common enough in production
  // to swamp the signal.
  //
  // That last assumption is UNMEASURED and the corpora argue against it: over
  // the five warn-emitting fixture cases, a `suburbMatch` rule would have been
  // 3/3 on real failures with 0 false positives, against `cityMatch`'s 2/3. The
  // objection is about production null-suburb rates, not the corpus. So once
  // live traffic exists, measure how often `userSuburb` is null; if it is lower
  // than feared, promote suburb to the primary signal — a one-line change here.
  if (confidence === 'crossed' || confidence === 'unverified') {
    const cityMatch = !userParts.city || !chosenParts.city
      ? 'unknown'
      : userParts.city === chosenParts.city
        ? 'agrees'
        : 'differs';
    console.warn(JSON.stringify({
      type: confidence === 'crossed'
        ? 'powerswitch_address_postcode_crossed'
        : 'powerswitch_address_postcode_unverified',
      userId,
      userPostcode: userParts.postcode,
      chosenPostcode: chosenParts.postcode,
      userSuburb: userParts.suburb,
      chosenSuburb: chosenParts.suburb,
      userCity: userParts.city,
      chosenCity: chosenParts.city,
      cityMatch,
      variant,
    }));
  }

  return { status: 'resolved', pxid, locationId, confidence };
}

/** Common NZ street-suffix abbreviations, expanded for comparison only. */
const STREET_ABBREVIATIONS: Record<string, string> = {
  rd: 'road', st: 'street', ave: 'avenue', av: 'avenue', dr: 'drive',
  cres: 'crescent', tce: 'terrace', pl: 'place', ln: 'lane', hwy: 'highway',
  mt: 'mount', esp: 'esplanade', pde: 'parade', sq: 'square', gr: 'grove',
};

/**
 * Compass suffixes that are part of a NZ street name rather than the locality
 * ("Victoria Street West" is a different street from "Victoria Street East",
 * sharing both suburb and postcode).
 */
const DIRECTIONAL_SUFFIXES = new Set(['north', 'south', 'east', 'west']);

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
 * One normalisation pass applied before any autocomplete query (issue #278).
 * Pure and — genuinely, now — IDEMPOTENT. Order: collapse whitespace; strip a
 * leading label prefix ("Supply Address:"); strip a trailing glued ICP token;
 * strip a trailing country suffix; trim trailing commas/semicolons. Macrons are
 * NOT folded here (Addressfinder indexes them) — folding is a query-variant,
 * not a sanitise step.
 *
 * The strips run to a FIXED POINT because each one can reveal another. This was
 * a real defect (#281 review), not defensive coding: the doc already claimed
 * idempotence and the code did not deliver it, so a stacked suffix like
 * "…Auckland 1010, NZ, New Zealand" left a residual ", NZ" after one pass. Two
 * concrete harms followed —
 *   1. The trailing postcode stayed hidden from `parseAddressParts`, so
 *      `resolveUserAddress`'s "user has no postcode" short-circuit fired while
 *      `rankAndPick` (which sanitises a SECOND time) saw the postcode. The ladder
 *      stopped early and crossed a postcode boundary with a same-postcode
 *      completion available one variant later — breaking the invariant this
 *      whole module rests on.
 *   2. The residual leaked into the query variants, so we sent Addressfinder
 *      literal junk like "1 Queen Street NZ".
 * TERMINATION: every operation in the loop is a pure deletion, so any iteration
 * that changes the string strictly SHORTENS it. The fixed-point break is
 * therefore the whole mechanism and cannot fail to trigger. The iteration guard
 * is derived from the input length purely so a future edit that accidentally
 * introduces a growing operation cannot spin — it can never expire before the
 * fixed point is reached under deletion-only strips. It is deliberately NOT a
 * small constant: a cap low enough to be hit would exit with a non-idempotent
 * string and silently resurrect harm 1 above, which is the failure mode this
 * whole comment exists to describe.
 */
export function sanitiseAddress(raw: string): string {
  let a = raw.replace(/\s+/g, ' ').trim();
  a = a.replace(/;/g, ','); // defect 8: semicolon separators → commas
  // Run the removable affixes to a fixed point — one strip can uncover the next.
  for (let guard = a.length; guard >= 0; guard--) {
    const before = a;
    a = a.replace(/^(?:(?:supply|service|installation|property|site)\s+)?address\s*:\s*/i, '');
    a = a.replace(/\s+icp:?\s*[a-z0-9]{10,}$/i, '');
    // \b so a place name merely ENDING in these letters survives: without it
    // "12 Franz Street, Franz" loses its last three characters.
    a = a.replace(/,?\s*\b(?:new zealand|nz|aotearoa)\s*$/i, '');
    a = a.replace(/[,\s;]+$/, '').trim();
    if (a === before) break;
  }
  return a;
}

/** Strip a leading unit prefix ("Unit 5, "/"Flat 2, "/"1/82 …"); null if none.
 *  For the slash form "1/82", the trailing number is the STREET number — keep it.
 *  Uses the shared UNIT_WORD_RE (defect 7), so Suite/Floor/Shop prefixes are
 *  stripped for a query variant too — exactly the recovery the ladder exists for. */
function stripUnitPrefix(s: string): string | null {
  const slash = s.match(/^(\d+[a-z]?)\s*\/\s*(\d+[a-z]?)\b/i);
  if (slash) {
    const kept = `${slash[2]} ${s.slice(slash[0].length).trim()}`.trim();
    return kept || null;
  }
  const word = s.match(UNIT_WORD_RE);
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
 * Built in PRIORITY ORDER and truncated to MAX_QUERY_VARIANTS (4): each entry is
 * one live POST, so once the cap is reached the lower-priority candidates below
 * are silently dropped. Deduped, no empties. Candidates, best first:
 *   1. sanitised as-is
 *   2. unit prefix removed ("Flat 2, 14 Wallace St" → "14 Wallace St")
 *   3. RD segment removed
 *   4. diacritics folded (macrons → ASCII)
 *   5. street + postcode only
 *   6. street + city, postcode dropped
 * Because the cap (4) is smaller than the candidate count (6), only the top of
 * this list is reached for a given address; do not rely on a later variant.
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

/**
 * Leading word-unit prefixes (NZ conventions). `level` collapses to the same
 * door class as `floor`; `suite`/`shop` are unit-style prefixes. This is the ONE
 * shared list (defect 7): both parsing (`UNIT_WORD_RE`) and the query-variant
 * stripper (`stripUnitPrefix`) derive from it so they cannot drift apart again.
 */
const UNIT_WORDS = ['unit', 'flat', 'apartment', 'apt', 'floor', 'shop', 'suite', 'level'];

/** Leading word-unit prefix ("Unit 5, "/"Suite 1, "), capturing the unit value. */
const UNIT_WORD_RE = new RegExp(`^(?:${UNIT_WORDS.join('|')})\\s+([0-9a-z]+)\\b[,\\s]*`, 'i');

/**
 * Parse an address into components for scoring. Best-effort & lenient — missing
 * fields are null. The street name ends at the FIRST street-type word at
 * index >= 1 (excluding mount/mt, which are NZ street-name prefixes), so a
 * no-comma "Queen Street Auckland Central" yields "queen street" while
 * "Mount Eden Road Auckland" yields "mount eden road". A numeric token right
 * after the type word is kept ("State Highway 2").
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

  // Street segment: leading number (incl. "82A"/"1-5"), then the name up to
  // the type word; anything after is the locality head.
  if (segments.length > 0) {
    const seg = segments.shift()!;
    const num = seg.match(/^(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\b/i);
    let rest = seg;
    if (num) {
      parts.number = num[1]!.replace(/\s+/g, '');
      parts.numberBase = parseInt(parts.number, 10);
      rest = seg.slice(num[0].length);
    }
    let tokens = rest.trim().split(/\s+/).filter(Boolean);
    // Defect 5: a stray comma after the number ("82, Verran Road") leaves this
    // segment as a bare number — fold the NEXT segment in as the street name.
    if (num && tokens.length === 0 && segments.length > 0) {
      tokens = segments.shift()!.trim().split(/\s+/).filter(Boolean);
    }
    // Name/type boundary (defect 6): the FIRST street-type word at index >= 1,
    // excluding mount/mt (NZ street-name prefixes, not terminators). The
    // trailing postcode was stripped above, so it cannot land here.
    // Route-number rule (defect 2): a single purely-numeric token right after
    // the type word ("State Highway 2") belongs to the name; a word token
    // starts the locality.
    // Directional rule: so does a compass suffix. "Victoria Street West" and
    // "Victoria Street East" are DIFFERENT streets that share a postcode and a
    // suburb, so demoting West/East to the locality left the street hard-reject
    // blind to them — with the correct twin missing from the completion set, we
    // resolved to the wrong side of the street. Same shape as the numeric rule.
    let typeIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      const lower = tokens[i]!.toLowerCase();
      if (i >= 1 && lower !== 'mount' && lower !== 'mt' && STREET_TYPE_WORDS.has(lower)) {
        typeIdx = i;
        break;
      }
    }
    let nameEnd = typeIdx;
    let localityStart = typeIdx + 1;
    if (typeIdx >= 0) {
      const after = tokens[typeIdx + 1];
      if (after !== undefined && (/^\d+$/.test(after) || DIRECTIONAL_SUFFIXES.has(after.toLowerCase()))) {
        nameEnd = typeIdx + 1;
        localityStart = typeIdx + 2;
      }
    }
    const nameTokens = typeIdx >= 0 ? tokens.slice(0, nameEnd + 1) : tokens;
    const localityHead = typeIdx >= 0 ? tokens.slice(localityStart) : [];
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
 * Iterative Levenshtein edit distance (issue #279). Two rolling rows, O(m·n)
 * time, O(min(m,n)) space. Hand-written — no new dependency. Used only to nudge
 * the ranking of NON-equal street names; an exact street match is worth far more
 * (see scoreCompletion), so this never decides a postcode-tier tie on its own.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Keep the shorter string as the inner dimension so the row arrays are small.
  if (n > m) return levenshtein(b, a);
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  // Both rows are fully populated before any read (prev above; curr[0] then
  // curr[j] left-to-right below), so every indexed access is defined — the `!`
  // assertions document that invariant for the noUncheckedIndexedAccess check.
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

/**
 * Normalised street-name similarity in [0,1]: `1 - distance / max(lenA, lenB)`,
 * clamped to [0,1], and 0 when either side has no street name. Both inputs are
 * already-normalised street names (lowercased, abbreviations expanded).
 */
export function streetSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0; // also covers empty strings, so max > 0 below
  const max = Math.max(a.length, b.length);
  const sim = 1 - levenshtein(a, b) / max;
  return sim < 0 ? 0 : sim > 1 ? 1 : sim;
}

/**
 * Score a candidate completion against the user's address. ALWAYS returns a
 * number (issue #279 — never rejects); higher is better. Postcode dominates
 * every other signal combined: the postcode is what drives plan accuracy, so
 * postcode agreement is worth +1000 (more than street+number+unit+suburb+city
 * can sum to) and a postcode mismatch is a -1000 penalty. A missing postcode on
 * either side is NEUTRAL (0), not a penalty — there is nothing to disagree with.
 *
 *   postcode both present & equal      +1000
 *   postcode both present & different  -1000
 *   postcode absent on either side        0
 *   street name equal                   +200
 *   street name not equal               + round(similarity * 150)
 *   numberBase equal                     +80
 *   number equal as written (incl. 82A)  +40
 *   unit equal (both null = equal)       +30
 *   suburb both present & equal          +40
 *   city both present & equal            +20
 */
export function scoreCompletion(userAddress: string, candidate: string): number {
  const u = parseAddressParts(userAddress);
  const c = parseAddressParts(candidate);

  let score = 0;
  // A PO Box CANDIDATE for a street-address user is never the right answer: a
  // postal postcode is not a distribution-network area, so it breaks the
  // postcode→location invariant the always-resolve policy rests on. Penalise
  // below the postcode weight so it can never outrank a real address, rather
  // than rejecting — this function must always return a number. (A PO Box on
  // the USER side never reaches here; resolveUserAddress short-circuits it.)
  if (isPoBox(candidate) && !isPoBox(userAddress)) score -= 2000;
  if (u.postcode && c.postcode) {
    score += u.postcode === c.postcode ? 1000 : -1000;
  }
  if (u.streetName && c.streetName) {
    score += u.streetName === c.streetName
      ? 200
      : Math.round(streetSimilarity(u.streetName, c.streetName) * 150);
  }
  if (u.numberBase !== null && c.numberBase !== null && u.numberBase === c.numberBase) score += 80;
  if (u.number && c.number && u.number === c.number) score += 40;
  if (u.unit === c.unit) score += 30; // both null counts as equal
  if (u.suburb && c.suburb && u.suburb === c.suburb) score += 40;
  if (u.city && c.city && u.city === c.city) score += 20;
  return score;
}

/**
 * Confidence tier of a chosen completion vs the user's address (issue #279):
 *   - exact    — postcode equal AND street name equal AND numberBase equal
 *   - postcode — postcode equal, but not exact
 *   - crossed    — both postcodes present and NOT equal
 *   - unverified — a postcode is absent on one or both sides
 * The postcode→location invariant holds for exact/postcode only; `crossed`
 * departs from it knowingly and `unverified` cannot confirm it.
 */
function confidenceTier(u: AddressParts, c: AddressParts): ResolveConfidence {
  // No postcode on one or both sides: nothing to compare, so this is unverified
  // rather than a known divergence. Kept distinct from `crossed` so the two can
  // be counted separately in logs.
  if (!u.postcode || !c.postcode) return 'unverified';
  if (u.postcode !== c.postcode) return 'crossed';
  const streetEqual = !!u.streetName && !!c.streetName && u.streetName === c.streetName;
  const numberBaseEqual = u.numberBase !== null && c.numberBase !== null && u.numberBase === c.numberBase;
  return streetEqual && numberBaseEqual ? 'exact' : 'postcode';
}

/**
 * Rank every completion and return the top one plus its confidence tier
 * (issue #279). THIS is the function `resolveUserAddress` calls, so it is the
 * one the fixture corpora must exercise — `pickBestMatch` is the public wrapper
 * around it and cannot be allowed to drift into being the only thing tested.
 *
 * PRECONDITION: `completions` must be non-empty. Callers guard this
 * (`resolveUserAddress` skips empty sets; `pickBestMatch` returns needs_review),
 * so this does not re-check it. The user address is sanitised first. Ties break by the
 * completion's original array order — Addressfinder's own ranking is the
 * tiebreaker, so a strict `>` (first-seen wins) is intentional.
 */
export function rankAndPick(
  completions: ReadonlyArray<PowerswitchCompletion>,
  userAddress: string
): { completion: PowerswitchCompletion; confidence: ResolveConfidence } {
  const user = sanitiseAddress(userAddress);
  const userParts = parseAddressParts(user);
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < completions.length; i++) {
    const s = scoreCompletion(user, completions[i]!.a);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  const completion = completions[bestIdx];
  if (!completion) {
    // Contract violation, not a recoverable state — there is no meaningful
    // result for an empty set, and a nullable return would push a dead branch
    // onto every caller. Named error beats the incidental TypeError.
    throw new Error('rankAndPick requires a non-empty completion set');
  }
  return { completion, confidence: confidenceTier(userParts, parseAddressParts(completion.a)) };
}

/**
 * Pick the best completion via postcode-anchored ranking (issue #279). ALWAYS
 * resolves for a non-empty completion array — there is no longer a reject path.
 * The only `needs_review` left is an empty array. The resolved outcome carries a
 * `confidence` tier so callers (and observability) can tell a same-postcode
 * resolution from one that crossed a postcode boundary or could not check.
 */
export function pickBestMatch(
  completions: ReadonlyArray<PowerswitchCompletion>,
  userAddress: string
): ResolveAddressOutcome {
  if (completions.length === 0) {
    return { status: 'needs_review', reason: 'zero_match', completions: 0 };
  }
  const { completion, confidence } = rankAndPick(completions, userAddress);
  return { status: 'resolved', pxid: completion.pxid, locationId: null, confidence };
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
