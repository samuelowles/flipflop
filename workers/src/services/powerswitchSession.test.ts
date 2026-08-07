import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveUserAddress,
  pickBestMatch,
  validateCompletions,
  addressHasUnit,
  isPowerswitchLive,
  postAction,
  householdRequestBody,
  sanitiseAddress,
  addressQueryVariants,
  scoreCompletion,
  parseAddressParts,
  AUTOCOMPLETE_ACTION,
  HOUSEHOLD_ACTION,
  POWERSWITCH_USER_AGENT,
  POWERSWITCH_BASE_URL,
  type PowerswitchSessionEnv,
  type PowerswitchCompletion,
} from './powerswitchSession';
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

/** A second, never-tuned-against corpus (20 live completion sets) — the holdout. */
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

describe('addressHasUnit (NZ unit heuristics)', () => {
  it('flags slash-separated unit prefixes', () => {
    expect(addressHasUnit('1/12 Birkdale Road, Birkdale')).toBe(true);
  });
  it('flags number+letter unit prefixes', () => {
    expect(addressHasUnit('12A Birkdale Road, Birkdale')).toBe(true);
  });
  it('flags Unit/Flat/Apartment word prefixes', () => {
    expect(addressHasUnit('Unit 3 Birkdale Road')).toBe(true);
    expect(addressHasUnit('Flat 2 Birkdale Road')).toBe(true);
    expect(addressHasUnit('Apartment 12 Queen Street')).toBe(true);
  });
  it('does not flag bare street numbers', () => {
    expect(addressHasUnit('1 Queen Street, Auckland Central')).toBe(false);
    expect(addressHasUnit('12 Birkdale Road, Birkdale')).toBe(false);
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

describe('pickBestMatch (match confidence)', () => {
  const completions: PowerswitchCompletion[] = [
    { a: '1 Queen Street, Auckland Central, Auckland 1010', pxid: BASE_PXID, v: 1 },
    { a: 'Unit 11, 1 Queen Street, Auckland Central, Auckland 1010', pxid: 'unit-11', v: 0 },
  ];
  it('picks the base (non-unit) completion when the user gave no unit', () => {
    const out = pickBestMatch(completions, '1 Queen Street, Auckland Central, Auckland 1010');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') expect(out.pxid).toBe(BASE_PXID);
  });
  it('resolves a single completion', () => {
    expect(pickBestMatch([completions[0]!], '1 Queen Street').status).toBe('resolved');
  });
  it('returns needs_review for zero completions', () => {
    expect(pickBestMatch([], 'nowhere')).toEqual({ status: 'needs_review', reason: 'zero_match', completions: 0 });
  });
  it('resolves to the matching unit when the user gave that exact unit', () => {
    // Scoring (#278): the unit-11 completion matches unit+number+street and
    // beats the unit-less base by more than the resolve margin → resolved.
    const out = pickBestMatch(completions, 'Unit 11, 1 Queen Street');
    expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-11' });
  });

  // Scoring edge cases (#278): postcode-anchored scoring replaces the old
  // exact-normalised-match rule. The lettered-number "82A Verran" cases below
  // exercise the score margins and the location-equivalent tie path.
  describe('scoring edge cases', () => {
    const verran: PowerswitchCompletion[] = [
      { a: '82 Verran Road, Birkdale, Auckland 0626', pxid: 'base-82', v: 1 },
      { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82a', v: 1 },
      { a: '82B Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82b', v: 1 },
    ];

    it('an exact lettered number resolves over its bare neighbours (number bonus clears the margin)', () => {
      // Regression: a real Meridian bill's "82A Verran Rd" was wrongly sent to
      // manual review. 82A scores 225 vs 82/82B at 175 — a 50-point gap, over the
      // 20-point resolve threshold, because the exact-number-as-written bonus is
      // +50. The matching lettered number must resolve outright.
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a' });
    });

    it('still resolves without a postcode (the exact-number bonus is margin-independent)', () => {
      // No postcode on the user side, but the exact "82A" number match still
      // clears the resolve margin, so the 82A completion resolves.
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a' });
    });

    it('unifies "1/82" and "Unit 1, 82" flat forms (unit match wins by margin)', () => {
      const flats: PowerswitchCompletion[] = [
        { a: 'Unit 1, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-1', v: 1 },
        { a: 'Unit 2, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-2', v: 1 },
      ];
      const out = pickBestMatch(flats, '1/240 Onewa Road, Birkenhead, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'flat-1' });
    });

    it('flags ambiguous when no completion matches the lettered number', () => {
      const out = pickBestMatch(verran, '82C Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'needs_review', reason: 'ambiguous' });
    });

    it('two identical completions resolve as location-equivalent (same door)', () => {
      // "82A Verran Rd" and "82A Verran Road" parse to identical parts and tie at
      // the top score; they are the same door differing only by spelling, so the
      // location-equivalent path resolves the first.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const dupes: PowerswitchCompletion[] = [
        { a: '82A Verran Rd, Birkdale, Auckland 0626', pxid: 'dupe-1', v: 1 },
        { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'dupe-2', v: 1 },
      ];
      const out = pickBestMatch(dupes, '82A Verran Road, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'dupe-1' });
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_address_location_equivalent'))).toBe(true);
      logSpy.mockRestore();
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

  it('query ladder: advances past a NON-EMPTY variant that resolves to nothing', async () => {
    // Live-observed (#278): a unit prefix makes Addressfinder return a full set
    // of the WRONG street — "Flat 2, 14 Wallace Street, Mount Cook, Wellington
    // 6021" yields six completions, none on Wallace Street, all hard-rejected
    // by the scoring. Advancing only on an EMPTY set would strand the address
    // in manual review even though the unit-stripped variant matches exactly.
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
        // Variant 0 (with the unit prefix) → non-empty but unresolvable.
        // Variant 1 (unit stripped) → the real address.
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
    expect(autocompletePosts).toBe(2); // did NOT stop at the non-empty wrong-street set
    expect(out).toMatchObject({ status: 'resolved', pxid: 'right-1' });
  });

  it('query ladder: an unresolvable ladder reports the FIRST variant\'s outcome', async () => {
    // When no variant resolves, the reported counts come from the most faithful
    // query rather than whichever loose variant happened to run last.
    const original = globalThis.fetch;
    let autocompletePosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === POWERSWITCH_BASE_URL + '/') {
        autocompletePosts++;
        // First variant: 3 wrong-street completions. Later variants: 1 wrong-street.
        const n = autocompletePosts === 1 ? 3 : 1;
        return new Response(
          `1:${JSON.stringify({
            completions: Array.from({ length: n }, (_, i) => ({
              a: `${i + 1} Nowhere Road, Elsewhere, Auckland 9999`,
              pxid: `no-${i}`,
              v: 1,
            })),
          })}`,
          { status: 200, headers: { 'content-type': 'text/x-component' } }
        );
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const out = await resolveUserAddress(env(true), 'u-none', '1 Queen Street, Auckland Central, Auckland 1010');
    globalThis.fetch = original;
    expect(out.status).toBe('needs_review');
    if (out.status === 'needs_review') expect(out.completions).toBe(3); // first variant's count
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
  it('sanitises the two required exact strings to the canonical form', () => {
    expect(sanitiseAddress('Supply Address: 1 Queen Street, Auckland Central, Auckland 1010'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
    expect(sanitiseAddress('1 Queen Street, Auckland Central, Auckland 1010 ICP 1000123456UN7C0'))
      .toBe('1 Queen Street, Auckland Central, Auckland 1010');
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

describe('scoreCompletion (postcode-anchored scoring, null = hard reject)', () => {
  it('hard-rejects a different street name', () => {
    expect(scoreCompletion('1 Queen Street, Auckland 1010', '1-5 Upper Queen Street, Auckland Central, Auckland 1010')).toBeNull();
  });
  it('hard-rejects a different street number', () => {
    expect(scoreCompletion('12 Willis Street, Wellington 6011', '14 Willis Street, Wellington Central, Wellington 6011')).toBeNull();
  });
  it('hard-rejects a postcode mismatch when the suburb is absent', () => {
    expect(scoreCompletion('1 Queen Street 1010', '1 Queen Street, Auckland Central, Auckland 0626')).toBeNull();
  });
  it('tolerates a postcode typo when the suburb agrees', () => {
    expect(scoreCompletion('1 Queen Street, Auckland Central, Auckland 1011', '1 Queen Street, Auckland Central, Auckland 1010')).not.toBeNull();
  });
  it('a postcode match outranks a suburb-only match', () => {
    const user = '1 Queen Street, Auckland Central, Auckland 1010';
    const postcodeMatch = scoreCompletion(user, '1 Queen Street, Ellerslie, Auckland 1010')!; // same postcode, diff suburb
    const suburbMatch = scoreCompletion(user, '1 Queen Street, Auckland Central, Auckland')!; // same suburb, no postcode
    expect(postcodeMatch).toBeGreaterThan(suburbMatch);
  });
  it('parses parts for inspection (sanity)', () => {
    const p = parseAddressParts('Unit 5, 10 High Street, Auckland Central, Auckland 1010');
    expect(p).toMatchObject({ unit: '5', number: '10', numberBase: 10, streetName: 'high street', suburb: 'auckland central', city: 'auckland', postcode: '1010' });
  });
});

/**
 * Issue #278 — table-driven suite over the 30 captured completion sets.
 * `pickBestMatch` is driven directly with each fixture's raw address + the live
 * completion array Powerswitch returned for it. The four cases that previously
 * resolved SILENTLY WRONG (A-country-suffix, A-label-prefix, F-typo-street,
 * G-street-only) are the critical regressions.
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
    reason?: 'zero_match' | 'ambiguous';
    locationEquivLog?: boolean;
    note?: string;
  };
  const expected: Record<string, Expect> = {
    // The clean "1 Queen Street" family — all resolve to the base completion.
    'A-exact': { status: 'resolved', chosenA: BASE_A },
    'A-uppercase': { status: 'resolved', chosenA: BASE_A },
    'A-no-commas': { status: 'resolved', chosenA: BASE_A },
    'A-no-postcode': { status: 'resolved', chosenA: BASE_A },
    'A-no-suburb': { status: 'resolved', chosenA: BASE_A },
    'A-street-postcode-only': { status: 'resolved', chosenA: BASE_A },
    'A-abbrev-st': { status: 'resolved', chosenA: BASE_A },
    'A-double-space': { status: 'resolved', chosenA: BASE_A },
    'A-trailing-comma': { status: 'resolved', chosenA: BASE_A },
    'A-postcode-comma': { status: 'resolved', chosenA: BASE_A },
    // Previously SILENT-WRONG (picked "1-5 Upper Queen Street") — now correct.
    'A-country-suffix': { status: 'resolved', chosenA: BASE_A },
    'A-label-prefix': { status: 'resolved', chosenA: BASE_A },
    // Postcode typo (1011 vs 1010) tolerated because the suburb agrees.
    'A-wrong-postcode': { status: 'resolved', chosenA: BASE_A },
    // "82A Verran Rd" — only the Verran completion survives (others are Salisbury/Verbena).
    'B-verran-known-fail': { status: 'resolved', chosenA: VERRAN_A },
    'B-verran-expanded': { status: 'resolved', chosenA: VERRAN_A },
    // Suburb absent from the user string; the unit+number+street match still wins.
    'C-unit-word': { status: 'resolved', chosenA: HIGH_A },
    // Only unit records exist for 166 Cashel — a unit-only tie, location-equivalent.
    'E-chch': { status: 'resolved', chosenContains: CASHEL_A, locationEquivLog: true },
    'E-hamilton': { status: 'resolved', chosenA: HAMILTON_A },
    // "12-14" → only "12 Willis Street" survives (the rest are other streets).
    'D-hyphen-range': { status: 'resolved', chosenA: WILLIS_A },
    // The correct street is genuinely ABSENT from these completion sets.
    'C-slash-unit': { status: 'needs_review', reason: 'zero_match' },
    'C-flat-word': { status: 'needs_review', reason: 'zero_match' },
    // Typo "Queeen" rejects every completion (no exact street) → must NOT pick Upper Queen Street.
    'F-typo-street': { status: 'needs_review', reason: 'zero_match' },
    // "Queen Street" alone — 10 different cities tie; must NOT pick Waihi/Awanui/Milton.
    'G-street-only': { status: 'needs_review', reason: 'ambiguous' },
    // Fixture has 0 completions (fixed on the QUERY side via the ladder, not here).
    'A-newline-sep': { status: 'needs_review', reason: 'zero_match' },
    'A-icp-glued': { status: 'needs_review', reason: 'zero_match' },
    'D-rural-rd': { status: 'needs_review', reason: 'zero_match' },
    'E-dunedin-no-pc': { status: 'needs_review', reason: 'zero_match' },
    'F-macron': { status: 'needs_review', reason: 'zero_match' },
    // "1010" alone — every completion's postcode differs and the user has no suburb → all rejected.
    'G-postcode-only': { status: 'needs_review', reason: 'zero_match' },
    // A PO Box is a postal facility, not a metered supply address — scoreCompletion
    // hard-rejects either side, so this correctly goes to manual review (deliberate).
    'G-po-box': { status: 'needs_review', reason: 'zero_match', note: 'PO Box deliberately rejected — not a metered address' },
  };

  for (const entry of FIXTURE) {
    it(`${entry.label} → ${expected[entry.label]!.status}`, () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const out = pickBestMatch(entry.completions, entry.address);
      const exp = expected[entry.label]!;

      if (exp.status === 'resolved') {
        expect(out.status).toBe('resolved');
        if (out.status === 'resolved') {
          const chosen = entry.completions.find((c) => c.pxid === out.pxid)?.a;
          if (exp.chosenA) expect(chosen).toBe(exp.chosenA);
          if (exp.chosenContains) expect(chosen).toContain(exp.chosenContains);
        }
        if (exp.locationEquivLog) {
          expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_address_location_equivalent'))).toBe(true);
        }
      } else {
        expect(out.status).toBe('needs_review');
        if (exp.reason && out.status === 'needs_review') expect(out.reason).toBe(exp.reason);
        // Explicit guard: the previously-silent-wrong cases must not resolve at all.
        expect(entry.completions.every((c) => !c.a.includes('Upper Queen Street')) || out.status === 'needs_review').toBe(true);
      }
      logSpy.mockRestore();
    });
  }
});

/**
 * Issue #278 holdout — a second, never-tuned-against corpus (20 live completion
 * sets), same table-driven shape as the 30-entry suite above. The single most
 * important property — asserted for EVERY entry that resolves — is that the
 * chosen completion's street name equals the user's street name. That is the
 * silent-wrong-door class this whole change exists to prevent; it is a real
 * assertion over parsed parts, not a hand-maintained list of strings.
 */
describe('pickBestMatch vs holdout corpus (20 real completion sets, never tuned against)', () => {
  const TUWHARETOA_A = '46 Tūwharetoa Street, Taupō 3330';
  const EMILY_A = 'Floor 3, 48 Emily Place, Auckland Central, Auckland 1010';
  const GREAT_SOUTH_A = '12 Great South Road, Papakura 2110';
  const MARINE_A = '70 Marine Parade, Napier South, Napier 4110';

  type Expect = {
    status: 'resolved' | 'needs_review';
    chosenA?: string;
    reason?: 'zero_match' | 'ambiguous';
    note?: string;
  };
  const expected: Record<string, Expect> = {
    // --- resolve: defect 2 (macron-folded bill text matches macronised records) ---
    'J-taupo-macron': { status: 'resolved', chosenA: TUWHARETOA_A },
    'J-taupo-folded': { status: 'resolved', chosenA: TUWHARETOA_A },
    // --- resolve: defect 3 ("Level N" matches the "Floor N" completion) ---
    'L-level-prefix': { status: 'resolved', chosenA: EMILY_A },
    // --- resolve: suburb dropped by Addressfinder; street + number + postcode anchor it ---
    'K-avenue-abbrev': { status: 'resolved', chosenA: GREAT_SOUTH_A },
    'K-lowercase-all': { status: 'resolved', chosenA: GREAT_SOUTH_A },
    // --- resolve: single exact completion ---
    'S-napier': { status: 'resolved', chosenA: MARINE_A },

    // --- zero completions in the fixture → needs_review/zero_match ---
    'H-rural-real': { status: 'needs_review', reason: 'zero_match' },
    'H-rural-no-rd': { status: 'needs_review', reason: 'zero_match' },
    'H-rural-sh-abbrev': { status: 'needs_review', reason: 'zero_match' },
    'P-attn-prefix': { status: 'needs_review', reason: 'zero_match' },

    // --- CORRECT needs_review: the user's actual street is absent from the set ---
    // Ōtāhuhu Road absent — completions are Nikau/Lippiatt/Gordon/Papaku/Ronaki/Pukeora Road.
    'I-macron-real': { status: 'needs_review', reason: 'zero_match' },
    'I-macron-folded': { status: 'needs_review', reason: 'zero_match' },
    // Hobson Street absent — completions are Albert Street / Victoria Street West.
    'L-apartment-word': { status: 'needs_review', reason: 'zero_match' },
    // Riddiford Street absent — completions are Daniell/Ferguson/Hall/Lawrence/Mein/Owen/Paeroa/Rhodes/Rintoul/Wilson Street.
    'M-suburb-only-no-city': { status: 'needs_review', reason: 'zero_match' },
    // Riddiford Street absent — completions are St George/Wellington/Benares/Buckingham/Chelsea Street across NZ.
    'M-city-only': { status: 'needs_review', reason: 'zero_match' },
    // Riddiford Street absent (double-comma address; same Newtown set).
    'N-double-comma': { status: 'needs_review', reason: 'zero_match' },
    // Riddiford Street absent (semicolon-separated; same Newtown set).
    'N-semicolon': { status: 'needs_review', reason: 'zero_match' },
    // Riddiford Street absent (tab-separated; same Newtown set).
    'O-tab-sep': { status: 'needs_review', reason: 'zero_match' },
    // Trafalgar Street absent — completions are Alfred/Brougham/Brunner/Franklyn/Ngatitama/Tipahi/Tukuka/Wellington/Motueka Street.
    'Q-nelson': { status: 'needs_review', reason: 'zero_match' },
    // Don Street absent — completions are Albany/Alice/Anglesey/Argyle/Arthur/Cushen/Dublin/Enniskillen/Farrar/Holloway Street.
    'R-invercargill': { status: 'needs_review', reason: 'zero_match' },
  };

  for (const entry of HOLDOUT) {
    it(`${entry.label} → ${expected[entry.label]!.status}`, () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const out = pickBestMatch(entry.completions, entry.address);
      const exp = expected[entry.label]!;

      if (exp.status === 'resolved') {
        expect(out.status).toBe('resolved');
        if (out.status === 'resolved') {
          const chosen = entry.completions.find((c) => c.pxid === out.pxid)?.a;
          if (exp.chosenA) expect(chosen).toBe(exp.chosenA);

          // THE critical property: the chosen completion's street name must equal
          // the user's street name. No silent wrong-door resolution. Real parse
          // over parts, not a hand-maintained string list.
          const chosenStreet = chosen ? parseAddressParts(chosen).streetName : null;
          const userStreet = parseAddressParts(sanitiseAddress(entry.address)).streetName;
          expect(userStreet).not.toBeNull();
          expect(chosenStreet).toBe(userStreet);
        }
      } else {
        expect(out.status).toBe('needs_review');
        if (exp.reason && out.status === 'needs_review') expect(out.reason).toBe(exp.reason);
      }
      logSpy.mockRestore();
    });
  }
});
