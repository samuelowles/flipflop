import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveUserAddress,
  pickBestMatch,
  validateCompletions,
  addressHasUnit,
  isPowerswitchLive,
  postAction,
  householdRequestBody,
  AUTOCOMPLETE_ACTION,
  HOUSEHOLD_ACTION,
  POWERSWITCH_USER_AGENT,
  POWERSWITCH_BASE_URL,
  type PowerswitchSessionEnv,
  type PowerswitchCompletion,
} from './powerswitchSession';
import { findFlightObject } from './powerswitchRscParser';
import { autocomplete_flight, household_flight } from './powerswitchLiveFixtures';

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
  it('flags ambiguous when the user gave a unit', () => {
    const out = pickBestMatch(completions, 'Unit 11, 1 Queen Street');
    expect(out.status).toBe('needs_review');
    if (out.status === 'needs_review') expect(out.reason).toBe('ambiguous');
  });

  // Exact-normalised-match rule — added after a real Meridian bill's lettered
  // street number ("82A Verran Rd") was sent to needs_review despite the
  // matching completion being in the list.
  describe('exact normalised match beats the unit bail-out', () => {
    const verran: PowerswitchCompletion[] = [
      { a: '82 Verran Road, Birkdale, Auckland 0626', pxid: 'base-82', v: 1 },
      { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82a', v: 1 },
      { a: '82B Verran Road, Birkdale, Auckland 0626', pxid: 'unit-82b', v: 1 },
    ];

    it('resolves a lettered street number to its exact completion (Rd ≡ Road)', () => {
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a' });
    });

    it('matches when the user address has no postcode', () => {
      const out = pickBestMatch(verran, '82A Verran Rd, Birkdale, Auckland');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'unit-82a' });
    });

    it('unifies "1/82" and "Unit 1, 82" flat forms', () => {
      const flats: PowerswitchCompletion[] = [
        { a: 'Unit 1, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-1', v: 1 },
        { a: 'Unit 2, 240 Onewa Road, Birkenhead, Auckland 0626', pxid: 'flat-2', v: 1 },
      ];
      const out = pickBestMatch(flats, '1/240 Onewa Road, Birkenhead, Auckland 0626');
      expect(out).toMatchObject({ status: 'resolved', pxid: 'flat-1' });
    });

    it('still flags ambiguous when no completion matches exactly and a unit was given', () => {
      const out = pickBestMatch(verran, '82C Verran Rd, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'needs_review', reason: 'ambiguous' });
    });

    it('two identical-normalising completions do not auto-resolve', () => {
      const dupes: PowerswitchCompletion[] = [
        { a: '82A Verran Rd, Birkdale, Auckland 0626', pxid: 'dupe-1', v: 1 },
        { a: '82A Verran Road, Birkdale, Auckland 0626', pxid: 'dupe-2', v: 1 },
      ];
      const out = pickBestMatch(dupes, '82A Verran Road, Birkdale, Auckland 0626');
      expect(out).toMatchObject({ status: 'needs_review', reason: 'ambiguous' });
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
});
