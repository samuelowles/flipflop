import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveUserAddress,
  pickBestMatch,
  validateCompletions,
  isPowerswitchLive,
  postAction,
  householdRequestBody,
  sanitiseAddress,
  addressQueryVariants,
  scoreCompletion,
  parseAddressParts,
  rankAndPick,
  levenshtein,
  streetSimilarity,
  AUTOCOMPLETE_ACTION,
  HOUSEHOLD_ACTION,
  POWERSWITCH_USER_AGENT,
  POWERSWITCH_BASE_URL,
  type PowerswitchSessionEnv,
  type PowerswitchCompletion,
  type ResolveConfidence,
} from './powerswitchSession';
import { updatePowerswitchLocation } from '../models/users';
import { findFlightObject } from './powerswitchRscParser';
import { autocomplete_flight, household_flight } from './powerswitchLiveFixtures';
import fixtureJson from '../../tests/fixtures/powerswitch-address-completions.json';
import holdoutJson from '../../tests/fixtures/powerswitch-address-completions-holdout.json';

/** Real captured completion sets per address string (issue #278 ground truth). */
interface FixtureEntry {
  readonly label: string;
  readonly address: string;
  readonly completions: ReadonlyArray<PowerswitchCompletion>;
}
const FIXTURE: ReadonlyArray<FixtureEntry> = fixtureJson as FixtureEntry[];

/** A second corpus (20 live completion sets) captured as a holdout — see the
 *  describe block below for what that does and does not still mean. */
const HOLDOUT: ReadonlyArray<FixtureEntry> = holdoutJson as FixtureEntry[];

/**
 * Issue #220/#240 — Powerswitch per-user address resolution, rebuilt against the
 * REAL captures. All tests stub `globalThis.fetch` (no live network);
 * POWERSWITCH_LIVE is 'true' only where we exercise the live-gated path.
 * setTimeout is mocked so the etiquette delays don't slow the suite.
 */

/** The base (non-unit) completion carried by the real autocomplete flight. */
const BASE_PXID = '2-.1.6.6.1aoR.';
/** The electricity location id the real household flight resolves to. */
const HOUSEHOLD_LOCATION_ID = '267';

function fakeDB(): D1Database {
  let runCount = 0;
  const db = {
    prepare: (_sql: string) => ({
      bind: (..._params: unknown[]) => ({
        run: async () => {
          runCount++;
          return { success: true, meta: {} };
        },
      }),
    }),
  } as unknown as D1Database;
  Object.defineProperty(db, '__runCount', { get: () => runCount });
  return db;
}

function env(live: boolean): PowerswitchSessionEnv {
  return {
    DB: fakeDB(),
    KV: {} as KVNamespace,
    POWERSWITCH_LIVE: live ? 'true' : 'false',
  };
}

/**
 * Stub fetch to serve the REAL captured flights: autocomplete for the address
 * POST, household for the pxid POST. Records every call's method/url/headers/body.
 */
function stubFlights() {
  const original = globalThis.fetch;
  const calls: {
    method: string;
    url: string;
    ua?: string;
    contentType?: string;
    accept?: string;
    nextAction?: string;
    bodyText?: string;
  }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = init?.headers instanceof Headers
      ? init.headers
      : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    calls.push({
      method,
      url,
      ua: headers.get('User-Agent') ?? undefined,
      contentType: headers.get('Content-Type') ?? undefined,
      accept: headers.get('Accept') ?? undefined,
      nextAction: headers.get('Next-Action') ?? undefined,
      bodyText: init?.body ? String(init.body) : undefined,
    });
    // autocomplete: POST / (root)
    if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
      return new Response(autocomplete_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    // household: POST /questionnaire/household?address_id=...
    if (method === 'POST' && url.includes('/questionnaire/household')) {
      return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    restore: () => { globalThis.fetch = original; },
    calls,
  };
}

describe('isPowerswitchLive (#219 gate)', () => {
  it('is inert when POWERSWITCH_LIVE is unset', () => {
    expect(isPowerswitchLive({ DB: {} as D1Database, KV: {} as KVNamespace })).toBe(false);
  });
  it('is armed only when POWERSWITCH_LIVE === "true"', () => {
    expect(isPowerswitchLive(env(true))).toBe(true);
    expect(isPowerswitchLive(env(false))).toBe(false);
  });
});

describe('householdRequestBody (ICP never submitted)', () => {
  it('builds the captured body shape with icp_identifier $undefined', () => {
    const body = householdRequestBody(BASE_PXID);
    expect(Array.isArray(body)).toBe(true);
    const text = JSON.stringify(body);
    expect(text).toContain(`"address_id":"${BASE_PXID}"`);
    expect(text).toContain('"icp_identifier":"$undefined"');
    // ICP value is never present — only the $undefined sentinel.
    expect(text).not.toMatch(/"icp_identifier":"[^$]/);
  });
});

describe('validateCompletions (real flight → 10 completions, base picked)', () => {
  it('accepts the real autocomplete flight object', () => {
    const obj = findFlightObject(autocomplete_flight, 'completions')!;
    const result = validateCompletions(obj);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // 10 completions in the real capture (base + Floor 1 + Unit 11..19).
      expect(result.completions).toHaveLength(10);
      const base = result.completions.find((c) => c.pxid === BASE_PXID)!;
      expect(base.a).toBe('1 Queen Street, Auckland Central, Auckland 1010');
    }
  });
  it('flags a non-object response as drift', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateCompletions('not an object').status).toBe('drift');
    spy.mockRestore();
  });
  it('flags a missing completions array as drift', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateCompletions({ results: [] }).status).toBe('drift');
    spy.mockRestore();
  });
  it('flags a malformed completion entry as drift', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateCompletions({ completions: [{ a: 'x' /* missing pxid, v */ }] }).status).toBe('drift');
    spy.mockRestore();
  });
});

describe('pickBestMatch (always resolves, with confidence)', () => {
  const completions: PowerswitchCompletion[] = [
    { a: '1 Queen Street, Auckland Central, Auckland 1010', pxid: BASE_PXID, v: 1 },
    { a: 'Unit 11, 1 Queen Street, Auckland Central, Auckland 1010', pxid: 'unit-11', v: 0 },
  ];
  it('picks the base (non-unit) completion when the user gave no unit', () => {
    const out = pickBestMatch(completions, '1 Queen Street, Auckland Central, Auckland 1010');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.pxid).toBe(BASE_PXID);
      expect(out.confidence).toBe('exact');
    }
  });
  it('resolves a single completion (no evidence floor anymore)', () => {
    // #279: any non-empty set resolves. '1 Queen Street 1010' shares postcode +
    // street + numberBase with the lone completion → exact.
    expect(pickBestMatch([completions[0]!], '1 Queen Street 1010'))
      .toMatchObject({ status: 'resolved', pxid: BASE_PXID, confidence: 'exact' });
  });
  it('returns needs_review for zero completions (the only needs_review left)', () => {
    expect(pickBestMatch([], 'nowhere')).toEqual({ status: 'needs_review', reason: 'zero_match', completions: 0 });
  });
  it('resolves to the matching unit when the user gave that exact unit', () => {
    // The unit-11 completion matches unit+number+street+postcode and beats the
    // unit-less base (unit bonus +30) → resolved, confidence exact.
    const out = pickBestMatch(completions, 'Unit 11, 1 Queen Street, Auckland Central, Auckland 1010');
    expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-11', confidence: 'exact' });
  });

  // Scoring edge cases (#279): postcode-anchored ranking. The lettered-number
  // "82A Verran" cases exercise the number-as-written bonus.
  describe('scoring edge cases', () => {
    const verran: PowerswitchCompletion[] = [
      { a: '82 Verran Road, Birkdale, Auckland 0626', pxid: 'base-82', v: 1 },
      { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82a', v: 1 },
      { a: '82B Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82b', v: 1 },
    ];

    it('an exact lettered number resolves over its bare neighbours (number-as-written bonus)', () => {
      // 82A scores the +40 exact-number bonus on top of the shared postcode +
      // street + numberBase, so it outranks 82/82B → resolved unit-82a, exact.
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a', confidence: 'exact' });
    });

    it('still resolves without a postcode (exact-number bonus is postcode-independent)', () => {
      // No postcode on the user side → neutral, not a penalty. The exact "82A"
      // number still wins on street + numberBase + number-as-written. confidence
      // is `unverified` because the user gave no postcode to check against.
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a', confidence: 'unverified' });
    });

    it('unifies "1/82" and "Unit 1, 82" flat forms (unit match wins)', () => {
      const flats: PowerswitchCompletion[] = [
        { a: 'Unit 1, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-1', v: 1 },
        { a: 'Unit 2, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-2', v: 1 },
      ];
      const out = pickBestMatch(flats, '1/240 Onewa Road, Birkenhead, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'flat-1', confidence: 'exact' });
    });

    it('resolves to the bare neighbour when no completion matches the lettered number', () => {
      // #279: previously needs_review/ambiguous; now resolves. 82C shares
      // postcode + street + numberBase (82) with all three, so it resolves exact
      // to the first (base-82) — numberBase agreement is enough for the exact
      // tier even though the letter differs.
      const out = pickBestMatch(verran, '82C Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'base-82', confidence: 'exact' });
    });

    it('two identical completions tie-break by array order (no special log)', () => {
      // "82A Verran Rd" and "82A Verran Road" parse to the same street and tie;
      // the first (dupe-1) wins by array order. There is no location-equivalent
      // log anymore (that path is gone under #279).
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const dupes: PowerswitchCompletion[] = [
        { a: '82A Verran Rd, Birkdale, Auckland 0626', pxid: 'dupe-1', v: 1 },
        { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'dupe-2', v: 1 },
      ];
      const out = pickBestMatch(dupes, '82A Verran Road, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'dupe-1', confidence: 'exact' });
      logSpy.mockRestore();
    });
  });

  // #279: the evidence floor is gone. A lone survivor on sparse evidence now
  // resolves (with an appropriate confidence tier) instead of going to review.
  describe('sparse survivors resolve (no evidence floor)', () => {
    it('a sparse street+number survivor resolves', () => {
      // No postcode on the user side → `unverified`. Street + number + numberBase
      // still rank it top of a one-element set.
      const out = pickBestMatch([{ a: '14 Wallace Street, Riccarton, Christchurch 8041', pxid: 'x', v: 1 }], '14 Wallace Street');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'x', confidence: 'unverified' });
    });
    it('a survivor with no street number resolves', () => {
      const out = pickBestMatch([{ a: '12 Highbrook Drive, East Tamaki, Auckland 2013', pxid: 'x', v: 1 }], 'Highbrook Drive, East Tamaki');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'x', confidence: 'unverified' });
    });
    it('a unit-only user string with no locality resolves', () => {
      const out = pickBestMatch([{ a: '3 Wallace Street, Wadestown, Wellington 6012', pxid: 'x', v: 1 }], 'Flat 2, Wallace Street');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'x', confidence: 'unverified' });
    });
  });
});

describe('postAction (server-action POST wire format)', () => {
  it('sends text/plain body + text/x-component accept + the action hash + identified UA', async () => {
    const original = globalThis.fetch;
    let captured: { headers: Headers; body: string } | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as Record<string, string>),
        body: String(init?.body ?? ''),
      };
      return new Response('0:["$@1",[]]\r\n1:{"completions":[]}', { status: 200 });
    }) as typeof globalThis.fetch;
    await postAction(POWERSWITCH_BASE_URL + '/', ['an address'], AUTOCOMPLETE_ACTION);
    globalThis.fetch = original;
    expect(captured!.headers.get('Content-Type')).toBe('text/plain;charset=UTF-8');
    expect(captured!.headers.get('Accept')).toBe('text/x-component');
    expect(captured!.headers.get('Next-Action')).toBe(AUTOCOMPLETE_ACTION);
    expect(captured!.headers.get('User-Agent')).toBe(POWERSWITCH_USER_AGENT);
    // Body is a JSON array literal sent as text/plain.
    expect(JSON.parse(captured!.body)).toEqual(['an address']);
  });
});

describe('resolveUserAddress (end-to-end against the real flights)', () => {
  let originalSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    const instant: typeof globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    vi.stubGlobal('setTimeout', instant);
  });
  afterEach(() => {
    vi.stubGlobal('setTimeout', originalSetTimeout);
    vi.restoreAllMocks();
  });

  it('clean base address → pxid + location(267) persisted, 2 POSTs', async () => {
    const stub = stubFlights();
    const out = await resolveUserAddress(env(true), 'u-1', '1 Queen Street, Auckland Central, Auckland 1010');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.pxid).toBe(BASE_PXID);
      expect(out.locationId).toBe(HOUSEHOLD_LOCATION_ID);
    }
    // Exactly two live POSTs: autocomplete + household.
    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    // Wire format on both calls.
    expect(posts.every((c) => c.contentType === 'text/plain;charset=UTF-8')).toBe(true);
    expect(posts.every((c) => c.accept === 'text/x-component')).toBe(true);
    expect(posts.every((c) => c.ua === POWERSWITCH_USER_AGENT)).toBe(true);
    expect(posts[0]!.nextAction).toBe(AUTOCOMPLETE_ACTION);
    expect(posts[1]!.nextAction).toBe(HOUSEHOLD_ACTION);
    // ICP value never appears in any submitted body.
    for (const c of posts) {
      expect(c.bodyText).not.toMatch(/"icp_identifier":"[^$]/);
    }
    stub.restore();
  });

  it('autocomplete body is ["<address>"] (the captured text/plain array)', async () => {
    const stub = stubFlights();
    await resolveUserAddress(env(true), 'u-1b', '1 Queen Street, Auckland Central, Auckland 1010');
    const autocomplete = stub.calls.find((c) => c.url === POWERSWITCH_BASE_URL + '/')!;
    expect(JSON.parse(autocomplete.bodyText!)).toEqual(['1 Queen Street, Auckland Central, Auckland 1010']);
    stub.restore();
  });

  it('POWERSWITCH_LIVE=false → disabled, zero live fetch', async () => {
    const stub = stubFlights();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(false), 'u-2', '1 Queen Street');
    expect(out.status).toBe('disabled');
    expect(stub.calls).toHaveLength(0); // INERT
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_live_disabled'))).toBe(true);
    stub.restore();
    logSpy.mockRestore();
  });

  it('drift (completions row missing) → drift outcome, no persist', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('0:["$@1",[]]\r\n1:{"something_else":{}}', {
        status: 200,
        headers: { 'content-type': 'text/x-component' },
      })) as typeof globalThis.fetch;
    const e = env(true);
    const db = e.DB as unknown as { __runCount: number };
    const out = await resolveUserAddress(e, 'u-3', '1 Queen Street');
    globalThis.fetch = original;
    expect(out.status).toBe('drift');
    expect(db.__runCount).toBe(0); // never persisted garbage
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_drift'))).toBe(true);
    errSpy.mockRestore();
  });

  it('autocomplete HTTP failure → error outcome, no persist', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof globalThis.fetch;
    const e = env(true);
    const db = e.DB as unknown as { __runCount: number };
    const out = await resolveUserAddress(e, 'u-4', '1 Queen Street');
    globalThis.fetch = original;
    expect(out.status).toBe('error');
    expect(db.__runCount).toBe(0);
  });

  it('query ladder: zero completions on variant 0 → a second variant is tried, then it stops (≤4 POSTs)', async () => {
    // Issue #278 query ladder. The first variant returns an empty completion
    // set, so the ladder must advance to the next variant; the first non-empty
    // set stops it. Never more than 4 autocomplete POSTs.
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        const flight = autocompletePosts === 1 ? '1:{"completions":[]}' : autocomplete_flight;
        return new Response(flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(true), 'u-ladder', '1 Queen Street, Auckland Central, Auckland 1010');
    globalThis.fetch = original;
    expect(autocompletePosts).toBe(2); // retried after the empty first variant, then stopped
    expect(autocompletePosts).toBeLessThanOrEqual(4);
    expect(out.status).toBe('resolved');
    // The winning variant index is logged on the resolved line.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('"variant":1') && String(c[0]).includes('powerswitch_address_resolved'))).toBe(true);
    logSpy.mockRestore();
  });

  it('query ladder: never issues more than 4 autocomplete POSTs when every variant is empty', async () => {
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        return new Response('1:{"completions":[]}', { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const out = await resolveUserAddress(env(true), 'u-empty', '1 Queen Street, Auckland Central, Auckland 1010');
    globalThis.fetch = original;
    expect(autocompletePosts).toBeLessThanOrEqual(4);
    expect(out.status).toBe('needs_review');
  });

  it('query ladder: keeps querying past a fallback-only variant to find a postcode match, then stops', async () => {
    // #279: a unit prefix makes Addressfinder return completions on the WRONG
    // street ("Flat 2, 14 Wallace Street, Mount Cook, Wellington 6021" →
    // Arlington/Hopper, both postcode 6011 vs the user's 6021). That variant
    // resolves at `fallback`, so the ladder must NOT stop — it keeps the
    // fallback as best-so-far and continues. The unit-stripped variant returns
    // the real Wallace Street 6021 completion, which resolves at `postcode`/
    // `exact`, so the ladder takes it and stops. The earlier fallback is
    // discarded in favour of the postcode match.
    const wrongStreet = JSON.stringify({
      completions: [
        { a: 'Flat 2, 14 Arlington Street, Mount Cook, Wellington 6011', pxid: 'wrong-1', v: 1 },
        { a: 'Shop 2, 14 Hopper Street, Mount Cook, Wellington 6011', pxid: 'wrong-2', v: 1 },
      ],
    });
    const rightStreet = JSON.stringify({
      completions: [{ a: '14 Wallace Street, Mount Cook, Wellington 6021', pxid: 'right-1', v: 1 }],
    });
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        // Variant 0 (with the unit prefix) → non-empty, wrong postcode → fallback.
        // Variant 1 (unit stripped) → the real address, postcode match → exact.
        return new Response(`1:${autocompletePosts === 1 ? wrongStreet : rightStreet}`, {
          status: 200,
          headers: { 'content-type': 'text/x-component' },
        });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(
      env(true),
      'u-unit-prefix',
      'Flat 2, 14 Wallace Street, Mount Cook, Wellington 6021'
    );
    globalThis.fetch = original;
    logSpy.mockRestore();
    expect(autocompletePosts).toBe(2); // did NOT stop at the fallback-only variant 0
    expect(out).toMatchObject({ status: 'resolved', pxid: 'right-1', confidence: 'exact' });
  });

  it('query ladder: keeps the FIRST variant\'s fallback when no variant yields a postcode match', async () => {
    // #279: when every variant resolves at `crossed` (none shares the user's
    // postcode), the ladder resolves using the FIRST variant's pick — an
    // earlier, more faithful query's fallback beats a later, looser one's. The
    // user's postcode is 1010 but every completion is in a different postcode,
    // so all variants are `crossed`; the first variant's pick (pxid 'first') must
    // win, not whichever loose variant ran last.
    const first = JSON.stringify({ completions: [{ a: '1 Queen Street, Auckland Central, Auckland 0601', pxid: 'first', v: 1 }] });
    const later = JSON.stringify({ completions: [{ a: '1 Queen Street, Auckland Central, Auckland 0602', pxid: 'later', v: 1 }] });
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        return new Response(`1:${autocompletePosts === 1 ? first : later}`, {
          status: 200,
          headers: { 'content-type': 'text/x-component' },
        });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(true), 'u-first-fallback', '1 Queen Street, Auckland Central, Auckland 1010');
    globalThis.fetch = original;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    expect(autocompletePosts).toBeGreaterThan(1); // queried past the first variant
    expect(autocompletePosts).toBeLessThanOrEqual(4);
    expect(out).toMatchObject({ status: 'resolved', pxid: 'first', confidence: 'crossed' });
  });

  it('a PO Box returns needs_review without issuing any fetch (PO Box short-circuit)', async () => {
    // A PO Box is a postal facility, not a metered supply address — we already
    // know it can never resolve, so no live request is spent on it.
    const stub = stubFlights();
    const out = await resolveUserAddress(env(true), 'u-po', 'PO Box 1234, Auckland 1140');
    expect(out).toMatchObject({ status: 'needs_review', reason: 'zero_match' });
    expect(stub.calls).toHaveLength(0); // INERT — no live POST
    stub.restore();
  });

  it('a cross-postcode resolution warns with both postcodes; an exact one does not', async () => {
    // #279: a `crossed` resolution picked a DIFFERENT postcode (wrong network
    // area), so it must emit a measurable console.warn carrying both the user's
    // and the chosen completion's postcode. An exact resolution must NOT warn.
    // --- crossed: user postcode 1010, the only completion is in 0601 ---
    const fallbackFlight = JSON.stringify({
      completions: [{ a: '1 Queen Street, Auckland Central, Auckland 0601', pxid: 'fb', v: 1 }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        return new Response(`1:${fallbackFlight}`, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(true), 'u-fb', '1 Queen Street, Auckland Central, Auckland 1010');
    globalThis.fetch = original;
    logSpy.mockRestore();
    expect(out).toMatchObject({ status: 'resolved', confidence: 'crossed' });
    const warnText = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnText.some((s) => s.includes('powerswitch_address_postcode_crossed'))).toBe(true);
    expect(warnText.some((s) => s.includes('"userPostcode":"1010"') && s.includes('"chosenPostcode":"0601"'))).toBe(true);
    warnSpy.mockRestore();

    // --- exact: the clean Queen Street address resolves exact and must NOT warn ---
    const stub = stubFlights();
    const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resolveUserAddress(env(true), 'u-exact-no-warn', '1 Queen Street, Auckland Central, Auckland 1010');
    stub.restore();
    logSpy2.mockRestore();
    const warnText2 = warnSpy2.mock.calls.map((c) => String(c[0]));
    expect(warnText2.some((s) => s.includes('powerswitch_address_postcode_'))).toBe(false);
    warnSpy2.mockRestore();
  });

  it('NEVER writes a street address to logs or warns (PII policy)', async () => {
    // docs/AI_RULES.md: "No user data in logs". docs/POWERSWITCH_COMPLIANCE.md
    // commits to Powerswitch, in a partner-facing table, that server logs are
    // "redacted of address/PII". installation_address is also encrypted at rest,
    // so emitting it next to `userId` would create a plaintext userId→address
    // pair in the log sink and partly defeat that encryption. Locality
    // (postcode/suburb/city) is what measurement needs and carries no
    // street-level identifier. This test pins that: no street name or street
    // number from either side may appear in any log or warn line.
    const flight = JSON.stringify({
      completions: [{ a: '77 Sandringham Road, Kingsland, Auckland 1025', pxid: 'pii', v: 1 }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        return new Response(`1:${flight}`, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveUserAddress(env(true), 'u-pii', '42 Marlborough Street, Kingsland, Auckland 1021');
    globalThis.fetch = original;
    const emitted = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');
    logSpy.mockRestore();
    warnSpy.mockRestore();

    // Neither the user's street nor the chosen completion's street may leak.
    for (const secret of ['Marlborough', 'marlborough', 'Sandringham', 'sandringham', '42 ', '77 ']) {
      expect(emitted, `"${secret}" must not reach logs`).not.toContain(secret);
    }
    // Locality IS expected — that is what makes the risk measurable.
    expect(emitted).toContain('"chosenPostcode":"1025"');
    expect(emitted).toContain('"userPostcode":"1021"');
    expect(emitted).toContain('"cityMatch"');
  });

  it('emits cityMatch so an unverified resolution is triageable', async () => {
    // #281 review: the risk concentrates where the user's postcode is MISSING —
    // exactly the condition that forces the `unverified` label — so the tier
    // alone is close to anti-correlated with real risk. `cityMatch` is what
    // carries the signal: 'differs' and 'unknown' are the states worth alerting
    // on. Here the user gives a city that AGREES with the chosen completion.
    const flight = JSON.stringify({
      completions: [{ a: '25 Buckingham Street, Melrose, Wellington 6023', pxid: 'cm', v: 1 }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        return new Response(`1:${flight}`, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(true), 'u-city', '25 Riddiford Street, Wellington');
    globalThis.fetch = original;
    logSpy.mockRestore();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    warnSpy.mockRestore();
    expect(out).toMatchObject({ status: 'resolved', confidence: 'unverified' });
    expect(warned).toContain('powerswitch_address_postcode_unverified');
    expect(warned).toContain('"cityMatch":"agrees"');
    expect(warned).toContain('"userCity":"wellington"');
  });

  it('a stacked country suffix does not make the short-circuit skip a postcode match', async () => {
    // #281 re-review BLOCKER. `sanitiseAddress` was not idempotent: one pass on
    // "…Auckland 1010, NZ, New Zealand" left ", NZ", hiding the trailing
    // postcode from parseAddressParts. The ladder's guard read that one-pass
    // string and saw no postcode, while rankAndPick sanitised a SECOND time and
    // did — so the ladder short-circuited on variant 0 and crossed a postcode
    // boundary with the correct completion available on variant 1.
    // Signature of the bug: the guard believed there was no user postcode, yet
    // the emitted tier was `crossed`, which REQUIRES both postcodes present.
    const wrong = JSON.stringify({ completions: [{ a: '9 Nowhere Road, Elsewhere, Auckland 0601', pxid: 'wrong', v: 1 }] });
    const right = JSON.stringify({ completions: [{ a: '1 Queen Street, Auckland Central, Auckland 1010', pxid: 'right', v: 1 }] });
    const original = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        posts++;
        return new Response(`1:${posts === 1 ? wrong : right}`, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(
      env(true),
      'u-stacked',
      '1 Queen Street, Auckland Central, Auckland 1010, NZ, New Zealand'
    );
    globalThis.fetch = original;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    expect(posts).toBe(2); // did NOT short-circuit — the postcode was visible
    expect(out).toMatchObject({ status: 'resolved', pxid: 'right', confidence: 'exact' });
  });

  it('an address with NO postcode stops after one autocomplete POST', async () => {
    // #281 review: confidenceTier returns `unverified` whenever the USER has no
    // postcode, whatever the candidate — so no later variant can ever reach a
    // postcode tier, and fetching them burns calls on a shared not-for-profit
    // resource to produce a result that is then discarded. Same reasoning as the
    // PO Box short-circuit.
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        return new Response(
          `1:${JSON.stringify({ completions: [{ a: '14 Wallace Street, Mount Cook, Wellington 6021', pxid: 'px-1', v: 1 }] })}`,
          { status: 200, headers: { 'content-type': 'text/x-component' } }
        );
      }
      if (method === 'POST' && url.includes('/questionnaire/household')) {
        return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(true), 'u-nopc', 'Flat 2, 14 Wallace Street, Mount Cook, Wellington');
    globalThis.fetch = original;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    expect(autocompletePosts).toBe(1); // not 3 — later variants cannot improve on this
    expect(out).toMatchObject({ status: 'resolved', pxid: 'px-1', confidence: 'unverified' });
  });

  it('updatePowerswitchLocation never writes installation_address', async () => {
    // #279 guard: a substituted completion must never overwrite the bill's
    // address. updatePowerswitchLocation writes only powerswitch_pxid +
    // powerswitch_location_id; pin that by capturing the SQL it issues so a
    // future change cannot quietly add installation_address.
    let capturedSql = '';
    const db = {
      prepare: (sql: string) => {
        capturedSql = sql;
        return { bind: (..._params: unknown[]) => ({ run: async () => ({ success: true, meta: {} }) }) };
      },
    } as unknown as D1Database;
    await updatePowerswitchLocation(db, 'u-x', { pxid: 'px1', locationId: '267' });
    expect(capturedSql).toContain('powerswitch_pxid');
    expect(capturedSql).toContain('powerswitch_location_id');
    expect(capturedSql).not.toMatch(/installation_address/i);
  });
});

// ---------------------------------------------------------------------------
// Address tolerance (issue #278): sanitise, query variants, scoring, fixture.
// ---------------------------------------------------------------------------

describe('sanitiseAddress (one normalisation pass before any query)', () => {
  it('passes a clean address through unchanged', () => {
    expect(sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
  });
  it('collapses newlines, tabs and runs of spaces to single spaces', () => {
    expect(sanitiseAddress('1 Queen Street\nAuckland Central\tAuckland  1010'))
      .toBe('1 Queen Street Auckland Central Auckland 1010');
  });
  it.each([
    'Supply Address: 1 Queen Street, Auckland 1010',
    'Service Address: 1 Queen Street, Auckland 1010',
    'Installation Address: 1 Queen Street, Auckland 1010',
    'Property Address: 1 Queen Street, Auckland 1010',
    'Site Address: 1 Queen Street, Auckland 1010',
    'address: 1 Queen Street, Auckland 1010',
  ])('strips the leading label prefix (%s)', (input) => {
    expect(sanitiseAddress(input)).toBe('1 Queen Street, Auckland 1010');
  });
  it('strips a trailing glued ICP token', () => {
    expect(sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010 ICP 1000123456UN7C0'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
  });
  it.each([
    ['1 Queen Street, Auckland Central, Auckland 1010, New Zealand'],
    ['1 Queen Street, Auckland Central, Auckland 1010, NZ'],
    ['1 Queen Street, Auckland Central, Auckland 1010, Aotearoa'],
  ])('strips a trailing country suffix (%s)', (input) => {
    expect(sanitiseAddress(input)).toBe('1 Queen Street, Auckland Central, Auckland 1010');
  });
  it('strips a trailing comma/semicolon', () => {
    expect(sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010,'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
  });
  it('normalises semicolon separators to commas (defect 8)', () => {
    // Without this, the whole tail after the first ';' is swallowed into the
    // street name and the suburb/city are lost.
    expect(sanitiseAddress('25 Riddiford Street; Newtown; Wellington 6021'))
      .toBe('25 Riddiford Street, Newtown, Wellington 6021');
  });
  it('sanitises the two required exact strings to the canonical form', () => {
    expect(sanitiseAddress('Supply Address: 1 Queen Street, Auckland Central, Auckland 1010'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
    expect(sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010 ICP 1000123456UN7C0'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
  });
  it('is idempotent — running it twice changes nothing', () => {
    // The doc claimed idempotence long before the code delivered it (#281
    // re-review). Each strip can uncover another, so they run to a fixed point.
    // A second pass silently revealing a postcode broke the ladder's
    // short-circuit; property-test the contract rather than one example.
    const inputs = [
      '1 Queen Street, Auckland Central, Auckland 1010, NZ, New Zealand',
      '1 Queen Street, Auckland 1010, New Zealand, NZ',
      'Supply Address: Site Address: 1 Queen Street, Auckland 1010',
      '1 Queen Street, Auckland 1010 ICP 1000123456UN7C0 ICP 1000123456UN7C0',
      '1 Queen Street, Auckland 1010,,, ;',
      '1 Queen Street, Auckland Central, Auckland 1010',
      'Queen Street',
      '',
    ];
    for (const input of inputs) {
      const once = sanitiseAddress(input);
      expect(sanitiseAddress(once), `not idempotent for: ${input}`).toBe(once);
    }
  });
  it('strips a STACKED country suffix in one call, revealing the postcode', () => {
    const out = sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010, NZ, New Zealand');
    expect(out).toBe('1 Queen Street, Auckland Central, Auckland 1010');
    // The postcode must be visible to the ladder's guard on the FIRST pass.
    expect(parseAddressParts(out).postcode).toBe('1010');
  });
  it('does not leak a country residual into the query variants', () => {
    // The residual used to be sent to Addressfinder verbatim ("1 Queen Street NZ").
    const variants = addressQueryVariants(
      sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010, NZ, New Zealand')
    );
    for (const v of variants) expect(v).not.toMatch(/\bNZ\b|new zealand|aotearoa/i);
  });
  it('does not fold macrons (Addressfinder indexes them)', () => {
    expect(sanitiseAddress('12 Ōtākaro Lane, Christchurch 8011')).toBe('12 Ōtākaro Lane, Christchurch 8011');
  });
});

describe('addressQueryVariants (ordered query ladder, deduped, ≤4)', () => {
  it('starts with the sanitised string and stays within the cap', () => {
    const v = addressQueryVariants('1 Queen Street, Auckland Central, Auckland 1010');
    expect(v[0]).toBe('1 Queen Street, Auckland Central, Auckland 1010');
    expect(v.length).toBeLessThanOrEqual(4);
    // No unit/RD/diacritics here → only street+postcode and street+city survive dedup.
    expect(v).toContain('1 Queen Street 1010');
    expect(v).toContain('1 Queen Street Auckland');
  });
  it.each([
    ['Unit 5, 10 High Street, Auckland 1010', '10 High Street, Auckland 1010'],
    ['Flat 2, 14 Wallace Street, Mount Cook, Wellington 6021', '14 Wallace Street, Mount Cook, Wellington 6021'],
    ['Apartment 3, 5 Test Street, Auckland 1010', '5 Test Street, Auckland 1010'],
    ['Apt 3, 5 Test Street, Auckland 1010', '5 Test Street, Auckland 1010'],
    ['1/82 Verran Road, Birkdale, Auckland 0626', '82 Verran Road, Birkdale, Auckland 0626'],
  ])('strips a unit prefix: %s', (input, stripped) => {
    expect(addressQueryVariants(input)).toContain(stripped);
  });
  it('strips Suite/Floor/Shop prefixes too (one shared unit list, defect 7)', () => {
    // stripUnitPrefix used to miss these three — no unit-stripped variant was
    // generated, so the recovery the ladder exists for never ran.
    expect(addressQueryVariants('Suite 3, 5 Test Street, Auckland 1010')).toContain('5 Test Street, Auckland 1010');
    expect(addressQueryVariants('Floor 3, 5 Test Street, Auckland 1010')).toContain('5 Test Street, Auckland 1010');
    expect(addressQueryVariants('Shop 3, 5 Test Street, Auckland 1010')).toContain('5 Test Street, Auckland 1010');
  });
  it('does NOT treat a lettered street number as a unit prefix', () => {
    const v = addressQueryVariants('82A Verran Road, Birkdale, Auckland 0626');
    expect(v).not.toContain('Verran Road, Birkdale, Auckland 0626'); // no unit-stripped form
    expect(v[0]).toBe('82A Verran Road, Birkdale, Auckland 0626');
  });
  it('strips an RD segment', () => {
    expect(addressQueryVariants('123 Kaipara Coast Highway, RD 2, Helensville 0874'))
      .toContain('123 Kaipara Coast Highway, Helensville 0874');
  });
  it('folds diacritics (macrons) into a variant', () => {
    expect(addressQueryVariants('12 Ōtākaro Lane, Christchurch Central, Christchurch 8011'))
      .toContain('12 Otakaro Lane, Christchurch Central, Christchurch 8011');
  });
  it('caps the list at 4 entries', () => {
    // unit + RD + diacritics + street+postcode + street+city → more than 4 raw candidates.
    const v = addressQueryVariants('Flat 2, 14 Ōtākaro Lane, RD 3, Testville 6021');
    expect(v.length).toBeLessThanOrEqual(4);
  });
  it('dedupes when variants collapse to the same string', () => {
    const v = addressQueryVariants('1 Queen Street, Auckland Central, Auckland 1010');
    expect(new Set(v).size).toBe(v.length); // no duplicates
  });
});

describe('scoreCompletion (postcode-anchored ranking, always returns a number)', () => {
  it('always returns a finite number, never null', () => {
    // #279: scoreCompletion never rejects — every candidate gets a score.
    for (const [u, c] of [
      ['1 Queen Street, Auckland 1010', '1-5 Upper Queen Street, Auckland Central, Auckland 1010'],
      ['12 Willis Street, Wellington 6011', '14 Willis Street, Wellington Central, Wellington 6011'],
      ['1 Queen Street 1010', '1 Queen Street, Auckland Central, Auckland 0626'],
      ['nowhere in particular', 'somewhere else entirely'],
    ] as const) {
      expect(typeof scoreCompletion(u, c)).toBe('number');
    }
  });
  it('an equal street scores higher than a different street (similarity nudge)', () => {
    const user = '1 Queen Street, Auckland Central, Auckland 1010';
    const equalStreet = scoreCompletion(user, '1 Queen Street, Ellerslie, Auckland 1010');
    const diffStreet = scoreCompletion(user, '1-5 Upper Queen Street, Auckland Central, Auckland 1010');
    expect(equalStreet).toBeGreaterThan(diffStreet);
  });
  it('a postcode mismatch is a heavy penalty (negative score)', () => {
    // Both sides carry a postcode (1010 vs 0626) → -1000 dominates everything.
    expect(scoreCompletion('1 Queen Street 1010', '1 Queen Street, Auckland Central, Auckland 0626')).toBeLessThan(0);
  });
  it('a missing postcode on either side is neutral, not a penalty', () => {
    // Same street + number, user has no postcode → no -1000; still positive.
    expect(scoreCompletion('1 Queen Street, Auckland Central, Auckland', '1 Queen Street, Auckland Central, Auckland 1010')).toBeGreaterThan(0);
  });
  it('postcode agreement outranks every other signal combined', () => {
    // The spec's invariant: a candidate matching ONLY the postcode must beat one
    // matching street + number + suburb + city but with a DIFFERENT postcode.
    // postcode(+1000) > street(200)+numberBase(80)+number(40)+unit(30)+suburb(40)+city(20) = 410.
    const user = '1 Queen Street, Auckland Central, Auckland 1010';
    const postcodeOnly = scoreCompletion(user, '99 Nowhere Road, Differenttown, Auckland 1010'); // shares ONLY postcode
    const everythingButPostcode = scoreCompletion(user, '1 Queen Street, Auckland Central, Auckland 0626'); // postcode differs, rest matches
    expect(postcodeOnly).toBeGreaterThan(everythingButPostcode);
  });
  it('keeps a route number in the street name so two highways differ (defect 2)', () => {
    // Highway 2 vs 33 parse to different streets; the Highway 2 completion still
    // scores higher for the Highway 2 user than the Highway 33 one.
    const user = '1837 State Highway 2, RD 2, Te Puke 3182';
    expect(scoreCompletion(user, '1837 State Highway 2, Te Puke 3182'))
      .toBeGreaterThan(scoreCompletion(user, '1837 State Highway 33, Te Puke 3182'));
  });

  describe('levenshtein + streetSimilarity helpers (#279, hand-written)', () => {
    it('levenshtein distance: identical strings = 0', () => {
      expect(levenshtein('queen street', 'queen street')).toBe(0);
    });
    it('levenshtein distance: empty operands', () => {
      expect(levenshtein('', 'abc')).toBe(3);
      expect(levenshtein('abc', '')).toBe(3);
      expect(levenshtein('', '')).toBe(0);
    });
    it('levenshtein distance: classic kitten→sitting = 3', () => {
      expect(levenshtein('kitten', 'sitting')).toBe(3);
    });
    it('levenshtein distance is symmetric', () => {
      expect(levenshtein('upper queen street', 'queen street')).toBe(levenshtein('queen street', 'upper queen street'));
    });
    it('streetSimilarity is normalised to [0,1], 1 for identical', () => {
      expect(streetSimilarity('queen street', 'queen street')).toBe(1);
      expect(streetSimilarity('upper queen street', 'queen street')).toBeCloseTo(1 - 6 / 18, 5);
    });
    it('streetSimilarity is 0 when either side has no street name', () => {
      expect(streetSimilarity(null, 'queen street')).toBe(0);
      expect(streetSimilarity('queen street', null)).toBe(0);
      expect(streetSimilarity(null, null)).toBe(0);
    });
  });

  // Compass suffixes stay in the street name, so the West/East twins are
  // DIFFERENT streets. They share a suburb AND a postcode, so under the new
  // always-resolve policy both resolve at the `postcode` tier when the correct
  // twin is absent — an accepted-risk same-network substitution, not a reject.
  describe('directional street suffixes', () => {
    const WEST_USER = '10 Victoria Street West, Auckland Central, Auckland 1010';
    const EAST = { a: '10 Victoria Street East, Auckland Central, Auckland 1010', pxid: 'east', v: 1 };
    const WEST = { a: '10 Victoria Street West, Auckland Central, Auckland 1010', pxid: 'west', v: 1 };

    it('keeps the compass suffix in the street name', () => {
      expect(parseAddressParts(WEST_USER).streetName).toBe('victoria street west');
      expect(parseAddressParts(EAST.a).streetName).toBe('victoria street east');
    });
    it('the correct twin scores higher than the opposite-direction twin', () => {
      expect(scoreCompletion(WEST_USER, WEST.a)).toBeGreaterThan(scoreCompletion(WEST_USER, EAST.a));
    });
    it('resolves to the opposite twin (same postcode) when the correct one is absent', () => {
      // #279: same postcode → postcode-tier resolution. East for a West user is
      // an accepted-risk same-network substitution, no longer needs_review.
      expect(pickBestMatch([EAST], WEST_USER)).toMatchObject({ status: 'resolved', pxid: 'east', confidence: 'postcode' });
    });
    it('still resolves to the correct twin, whatever the completion order', () => {
      expect(pickBestMatch([EAST, WEST], WEST_USER)).toMatchObject({ status: 'resolved', pxid: 'west', confidence: 'exact' });
      expect(pickBestMatch([WEST, EAST], WEST_USER)).toMatchObject({ status: 'resolved', pxid: 'west', confidence: 'exact' });
    });
    it('does not eat a compass word that is really the suburb', () => {
      // "New Lynn" / "West Auckland" style: the token after the type word is a
      // locality, and a bare "West" suburb must not be pulled into the name.
      expect(parseAddressParts('12 Great North Road, New Lynn, Auckland 0600').streetName)
        .toBe('great north road');
    });
  });
  it('a postcode match outranks a suburb-only match', () => {
    const user = '1 Queen Street, Auckland Central, Auckland 1010';
    const postcodeMatch = scoreCompletion(user, '1 Queen Street, Ellerslie, Auckland 1010'); // same postcode, diff suburb
    const suburbMatch = scoreCompletion(user, '1 Queen Street, Auckland Central, Auckland'); // same suburb, no postcode
    expect(postcodeMatch).toBeGreaterThan(suburbMatch);
  });
  it('parses parts for inspection (sanity)', () => {
    const p = parseAddressParts('Unit 5, 10 High Street, Auckland Central, Auckland 1010');
    expect(p).toMatchObject({ unit: '5', number: '10', numberBase: 10, streetName: 'high street', suburb: 'auckland central', city: 'auckland', postcode: '1010' });
  });
});

describe('parseAddressParts (street-name boundary: defects 5 & 6)', () => {
  it('folds the next segment in when a stray comma follows the number (defect 5)', () => {
    // "82, Verran Road" left the street segment as a bare number; the name must
    // come from the following segment so the street hard-reject can fire.
    expect(parseAddressParts('82, Verran Road, Birkdale, Auckland 0626')).toMatchObject({
      number: '82', numberBase: 82, streetName: 'verran road', suburb: 'birkdale', city: 'auckland', postcode: '0626',
    });
  });
  it.each([
    ['Rewa Road Mount Eden Auckland', 'rewa road'],
    ['Mount Eden Road Auckland', 'mount eden road'],
    ['Great South Road Papakura Auckland', 'great south road'],
    ['Queen Street Auckland Central', 'queen street'],
    // "St" is an abbreviation: normaliseStreetName expands it to "street" (this
    // is the same expansion "Queen St" → "queen street" relies on). The boundary
    // rule is what's under test here — the name spans all four tokens rather
    // than truncating at the idx-0 "st", which a LAST-type-word rule would do.
    ['St Heliers Bay Road Auckland', 'street heliers bay road'],
    ['Rewa Road St Heliers Auckland', 'rewa road'],
    ['State Highway 2 Te Puke', 'state highway 2'],
  ])('street-name boundary (defect 6): %s → %s', (input, streetName) => {
    // FIRST street-type word at index >= 1, excluding mount/mt; a numeric token
    // right after the type word stays in the name (defect 2's route-number rule).
    expect(parseAddressParts(input).streetName).toBe(streetName);
  });
});

/**
 * The correctness invariant under the #279 always-resolve policy: if the user's
 * address carries a postcode AND at least one completion shares it, the chosen
 * completion's postcode MUST equal the user's and the confidence must be `exact`
 * or `postcode`. That is the property that keeps the postcode→location invariant
 * intact — substituting a neighbouring address is only harmless inside one
 * postcode. Asserted programmatically over parseAddressParts, not as a
 * hand-maintained list. (When the user has no postcode, or no completion shares
 * it, the invariant does not apply and there is nothing to check.)
 */
function assertPostcodeInvariant(
  userAddress: string,
  completions: ReadonlyArray<PowerswitchCompletion>,
  chosenA: string | undefined,
  confidence: ResolveConfidence,
): void {
  const userPc = parseAddressParts(sanitiseAddress(userAddress)).postcode;
  if (!userPc) return; // no user postcode → nothing to verify against
  const anyShares = completions.some((c) => parseAddressParts(c.a).postcode === userPc);
  if (!anyShares) return; // postcode absent from the candidate set → invariant N/A
  expect(chosenA, 'chosen completion address must be present').toBeDefined();
  expect(parseAddressParts(chosenA!).postcode, 'chosen completion must carry the shared postcode').toBe(userPc);
  expect(confidence, 'a shared-postcode resolution is exact or postcode, never crossed/unverified')
    .not.toMatch(/^(crossed|unverified)$/);
}

/**
 * Issue #279 — table-driven suite over the 30 captured completion sets. Under
 * the always-resolve policy EVERY non-empty completion set resolves; only the
 * genuinely empty arrays still go to needs_review. The postcode invariant
 * (assertPostcodeInvariant) runs for every resolution, and per-entry confidence
 * is pinned to the tier the ranking actually produces.
 */
describe('pickBestMatch vs captured fixture (30 real completion sets)', () => {
  const BASE_A = '1 Queen Street, Auckland Central, Auckland 1010';
  const VERRAN_A = '82 Verran Road, Birkdale, Auckland 0626';
  const HIGH_A = 'Unit 5, 10 High Street, Auckland Central, Auckland 1010';
  const CASHEL_A = '166 Cashel Street, Christchurch Central, Christchurch 8011';
  const HAMILTON_A = '5 Garden Place, Hamilton Central, Hamilton 3204';
  const WILLIS_A = '12 Willis Street, Wellington Central, Wellington 6011';

  type Expect = {
    status: 'resolved' | 'needs_review';
    chosenA?: string;
    chosenContains?: string;
    confidence?: ResolveConfidence;
    reason?: 'zero_match';
    note?: string;
  };
  const expected: Record<string, Expect> = {
    // The clean "1 Queen Street" family — all resolve to the base completion.
    'A-exact': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-uppercase': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-no-commas': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    // User gave no postcode → the right address still wins, but there was no
    // postcode to check it against, so the tier is `unverified` (NOT `crossed`:
    // nothing diverged, we just could not verify).
    'A-no-postcode': { status: 'resolved', chosenA: BASE_A, confidence: 'unverified' },
    'A-no-suburb': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-street-postcode-only': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-abbrev-st': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-double-space': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-trailing-comma': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-postcode-comma': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-country-suffix': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    'A-label-prefix': { status: 'resolved', chosenA: BASE_A, confidence: 'exact' },
    // Postcode typo (1011 vs 1010): no completion shares 1011, so we knowingly
    // picked a different postcode → `crossed`. The chosen address is still the
    // right door, but this is the tier that must be counted: had the typo been
    // a real other postcode, this is exactly how a user gets the wrong network.
    'A-wrong-postcode': { status: 'resolved', chosenA: BASE_A, confidence: 'crossed' },
    // "82A Verran Rd" — the Verran completion wins on street + numberBase + postcode.
    'B-verran-known-fail': { status: 'resolved', chosenA: VERRAN_A, confidence: 'exact' },
    'B-verran-expanded': { status: 'resolved', chosenA: VERRAN_A, confidence: 'exact' },
    // Suburb absent from the user string; unit + number + street + postcode win.
    'C-unit-word': { status: 'resolved', chosenA: HIGH_A, confidence: 'exact' },
    // Only unit records exist for 166 Cashel — they tie; the first (a unit) wins.
    'E-chch': { status: 'resolved', chosenContains: CASHEL_A, confidence: 'exact' },
    'E-hamilton': { status: 'resolved', chosenA: HAMILTON_A, confidence: 'exact' },
    // "12-14" → "12 Willis Street" wins (numberBase 12 agrees).
    'D-hyphen-range': { status: 'resolved', chosenA: WILLIS_A, confidence: 'exact' },
    // Verran/Wallace ABSENT but a same-postcode neighbour exists → postcode tier.
    // The postcode invariant guarantees the chosen completion shares the user's
    // postcode — exactly the harmless substitution #279 enables.
    'C-slash-unit': { status: 'resolved', confidence: 'postcode' },
    'C-flat-word': { status: 'resolved', confidence: 'postcode' },
    // Typo "Queeen" → the real "Queen Street" 1010 completion wins on postcode +
    // numberBase + a high street similarity. Previously needs_review; a typo'd
    // street in the right postcode is a correct resolution under #279.
    'F-typo-street': { status: 'resolved', chosenA: BASE_A, confidence: 'postcode' },
    // No postcode in the input → no way to verify the network area. This is THE
    // accepted-risk case: "Queen Street" alone resolves to a Queen Street in
    // some other city (Waihi 3610 ranks top), which is a genuinely wrong network.
    // The owner chose resolution over review; `unverified` is what makes it
    // countable.
    'G-street-only': { status: 'resolved', confidence: 'unverified' },
    // User typed only "1010", which parses AS a postcode; every completion is in
    // a different one, so we knowingly cross → `crossed`.
    'G-postcode-only': { status: 'resolved', confidence: 'crossed' },
    // A PO Box reaches pickBestMatch only in this isolated test — the LIVE path
    // (resolveUserAddress) short-circuits PO Boxes before this code runs, so this
    // resolution never happens in production. The short-circuit has its own test.
    'G-po-box': { status: 'resolved', confidence: 'postcode' },
    // Genuinely empty completion arrays → still needs_review (the only such case).
    'A-newline-sep': { status: 'needs_review', reason: 'zero_match' },
    'A-icp-glued': { status: 'needs_review', reason: 'zero_match' },
    'D-rural-rd': { status: 'needs_review', reason: 'zero_match' },
    'E-dunedin-no-pc': { status: 'needs_review', reason: 'zero_match' },
    'F-macron': { status: 'needs_review', reason: 'zero_match' },
  };

  for (const entry of FIXTURE) {
    it(`${entry.label} → ${expected[entry.label]!.status}`, () => {
      // Driven through rankAndPick — the function resolveUserAddress actually
      // calls (#281 review). pickBestMatch is the public wrapper; asserting both
      // agree keeps the wrapper from drifting away from the live path.
      const out = pickBestMatch(entry.completions, entry.address);
      if (entry.completions.length > 0) {
        const picked = rankAndPick(entry.completions, entry.address);
        expect(out).toMatchObject({
          status: 'resolved', pxid: picked.completion.pxid, confidence: picked.confidence,
        });
      }
      const exp = expected[entry.label]!;

      if (exp.status === 'resolved') {
        expect(out.status).toBe('resolved');
        if (out.status === 'resolved') {
          const chosen = entry.completions.find((c) => c.pxid === out.pxid)?.a;
          if (exp.chosenA) expect(chosen).toBe(exp.chosenA);
          if (exp.chosenContains) expect(chosen).toContain(exp.chosenContains);
          if (exp.confidence) expect(out.confidence).toBe(exp.confidence);
          assertPostcodeInvariant(entry.address, entry.completions, chosen, out.confidence);
        }
      } else {
        expect(out).toMatchObject({ status: 'needs_review', reason: 'zero_match' });
        // An empty completion set is the ONLY needs_review path left.
        expect(entry.completions).toHaveLength(0);
      }
    });
  }
});

/**
 * Issue #279 holdout — the second corpus (20 live completion sets). Captured
 * after the original scoring was written; it surfaced the macron-folding and
 * "Level N" fixes and still earns its keep as regression cover. Treat a green
 * run here as regression cover, not evidence of generalisation — for that,
 * capture a fresh corpus.
 *
 * The single most important property — asserted for EVERY entry that resolves —
 * is the POSTCODE INVARIANT (assertPostcodeInvariant): when the user has a
 * postcode and some completion shares it, the chosen completion's postcode
 * equals the user's and the confidence is exact/postcode. The old
 * "chosen street == user street" property no longer holds by design — a
 * same-postcode neighbour now resolves in preference to review.
 */
describe('pickBestMatch vs holdout corpus (20 real completion sets)', () => {
  const TUWHARETOA_A = '46 Tūwharetoa Street, Taupō 3330';
  const EMILY_A = 'Floor 3, 48 Emily Place, Auckland Central, Auckland 1010';
  const GREAT_SOUTH_A = '12 Great South Road, Papakura 2110';
  const MARINE_A = '70 Marine Parade, Napier South, Napier 4110';

  type Expect = {
    status: 'resolved' | 'needs_review';
    chosenA?: string;
    confidence?: ResolveConfidence;
    reason?: 'zero_match';
    note?: string;
  };
  const expected: Record<string, Expect> = {
    // --- exact resolutions (street + numberBase + postcode all agree) ---
    'J-taupo-macron': { status: 'resolved', chosenA: TUWHARETOA_A, confidence: 'exact' },
    'J-taupo-folded': { status: 'resolved', chosenA: TUWHARETOA_A, confidence: 'exact' },
    'L-level-prefix': { status: 'resolved', chosenA: EMILY_A, confidence: 'exact' },
    'K-avenue-abbrev': { status: 'resolved', chosenA: GREAT_SOUTH_A, confidence: 'exact' },
    'K-lowercase-all': { status: 'resolved', chosenA: GREAT_SOUTH_A, confidence: 'exact' },
    'S-napier': { status: 'resolved', chosenA: MARINE_A, confidence: 'exact' },

    // --- postcode-tier resolutions: the user's street is ABSENT but a same-
    //     postcode neighbour exists. The postcode invariant guarantees the
    //     chosen completion shares the user's postcode (harmless substitution). ---
    'I-macron-real': { status: 'resolved', confidence: 'postcode' },
    'I-macron-folded': { status: 'resolved', confidence: 'postcode' },
    'L-apartment-word': { status: 'resolved', confidence: 'postcode' },
    'M-suburb-only-no-city': { status: 'resolved', confidence: 'postcode' },
    'N-double-comma': { status: 'resolved', confidence: 'postcode' },
    'N-semicolon': { status: 'resolved', confidence: 'postcode' },
    'O-tab-sep': { status: 'resolved', confidence: 'postcode' },
    'Q-nelson': { status: 'resolved', confidence: 'postcode' },
    // Don Street absent; some completions share 9810 → chosen is in 9810, postcode tier.
    'R-invercargill': { status: 'resolved', confidence: 'postcode' },

    // --- the user gave NO postcode (only a city) → unverifiable, not crossed ---
    'M-city-only': { status: 'resolved', confidence: 'unverified' },

    // --- genuinely empty completion arrays → needs_review/zero_match ---
    'H-rural-real': { status: 'needs_review', reason: 'zero_match' },
    'H-rural-no-rd': { status: 'needs_review', reason: 'zero_match' },
    'H-rural-sh-abbrev': { status: 'needs_review', reason: 'zero_match' },
    'P-attn-prefix': { status: 'needs_review', reason: 'zero_match' },
  };

  for (const entry of HOLDOUT) {
    it(`${entry.label} → ${expected[entry.label]!.status}`, () => {
      // Driven through rankAndPick — the function resolveUserAddress actually
      // calls (#281 review). pickBestMatch is the public wrapper; asserting both
      // agree keeps the wrapper from drifting away from the live path.
      const out = pickBestMatch(entry.completions, entry.address);
      if (entry.completions.length > 0) {
        const picked = rankAndPick(entry.completions, entry.address);
        expect(out).toMatchObject({
          status: 'resolved', pxid: picked.completion.pxid, confidence: picked.confidence,
        });
      }
      const exp = expected[entry.label]!;

      if (exp.status === 'resolved') {
        expect(out.status).toBe('resolved');
        if (out.status === 'resolved') {
          const chosen = entry.completions.find((c) => c.pxid === out.pxid)?.a;
          if (exp.chosenA) expect(chosen).toBe(exp.chosenA);
          if (exp.confidence) expect(out.confidence).toBe(exp.confidence);
          assertPostcodeInvariant(entry.address, entry.completions, chosen, out.confidence);
        }
      } else {
        expect(out).toMatchObject({ status: 'needs_review', reason: 'zero_match' });
        expect(entry.completions).toHaveLength(0);
      }
    });
  }
});
