import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveUserAddress,
  pickBestMatch,
  validateCompletions,
  addressHasUnit,
  isPowerswitchLive,
  POWERSWITCH_USER_AGENT,
  type PowerswitchSessionEnv,
} from './powerswitchSession';
import {
  autocomplete_single_match,
  autocomplete_ambiguous_units,
  autocomplete_zero_match,
  autocomplete_drift_response,
  SINGLE_MATCH_LOCATION_ID,
} from './powerswitchFixtures';

/**
 * Issue #220 — Powerswitch per-user address resolution. All tests stub
 * `globalThis.fetch` (no live network); POWERSWITCH_LIVE is only 'true' where
 * we are explicitly exercising the live-gated path. Timers are mocked so the
 * etiquette delays don't slow the suite.
 */

/**
 * Fake D1 that counts UPDATE runs (so tests can assert "no persist happened").
 * Exposes `__runCount` for the failure-path assertions.
 */
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

/** Stub fetch with per-URL JSON or Location-header responses. */
function stubFetch(opts: {
  postBody?: unknown;
  postStatus?: number;
  locationHeader?: string | null;
}) {
  const original = globalThis.fetch;
  const calls: { method: string; url: string; ua?: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const ua = init?.headers instanceof Headers
      ? init.headers.get('User-Agent') ?? undefined
      : (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
    calls.push({ method, url, ua });
    if (method === 'POST') {
      if (opts.postStatus && opts.postStatus >= 500) {
        return new Response('err', { status: opts.postStatus });
      }
      return new Response(JSON.stringify(opts.postBody ?? autocomplete_single_match), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // GET questionnaire redirect
    const headers = new Headers();
    if (opts.locationHeader !== undefined && opts.locationHeader !== null) {
      headers.set('Location', opts.locationHeader);
    }
    // 3xx when a Location is present, else 200
    const status = opts.locationHeader ? 303 : 200;
    return new Response(opts.locationHeader ? '' : '<html></html>', { status, headers });
  }) as typeof globalThis.fetch;
  const restore = () => { globalThis.fetch = original; };
  return {
    restore,
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

describe('validateCompletions (drift detection)', () => {
  it('accepts a well-shaped response', () => {
    const result = validateCompletions(autocomplete_single_match);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.completions).toHaveLength(1);
      expect(result.completions[0]!.pxid).toBe('2-.1.6.6.1aoR.');
    }
  });
  it('flags a non-object response as drift', () => {
    const result = validateCompletions('not an object');
    expect(result.status).toBe('drift');
  });
  it('flags a missing completions array as drift', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateCompletions(autocomplete_drift_response);
    expect(result.status).toBe('drift');
    // structured error logged
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls[0]![0] as string;
    expect(logged).toContain('powerswitch_drift');
    spy.mockRestore();
  });
  it('flags a malformed completion entry as drift', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateCompletions({ completions: [{ a: 'x' /* missing pxid, v */ }] });
    expect(result.status).toBe('drift');
    spy.mockRestore();
  });
});

describe('pickBestMatch (match confidence)', () => {
  it('resolves a single completion', () => {
    const out = pickBestMatch(autocomplete_single_match.completions, '1 Queen Street');
    expect(out.status).toBe('resolved');
  });
  it('returns needs_review for zero completions', () => {
    const out = pickBestMatch([], 'nowhere');
    expect(out).toEqual({ status: 'needs_review', reason: 'zero_match', completions: 0 });
  });
  it('picks the base address when user gave no unit and a base exists', () => {
    const base = autocomplete_ambiguous_units.completions[0]!;
    const out = pickBestMatch(autocomplete_ambiguous_units.completions, base.a);
    expect(out.status).toBe('resolved');
  });
  it('flags ambiguous when user gave a unit', () => {
    const out = pickBestMatch(
      autocomplete_ambiguous_units.completions,
      '12A Birkdale Road, Birkdale'
    );
    expect(out.status).toBe('needs_review');
    if (out.status === 'needs_review') expect(out.reason).toBe('ambiguous');
  });
  it('flags ambiguous when all completions are unit-level and user gave no unit', () => {
    const units = [
      { a: '12A Birkdale Road', pxid: 'p1', v: 1 },
      { a: '12B Birkdale Road', pxid: 'p2', v: 1 },
    ];
    const out = pickBestMatch(units, '12 Birkdale Road');
    expect(out.status).toBe('needs_review');
  });
});

describe('resolveUserAddress (end-to-end, fetch mocked)', () => {
  let originalSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    // skip etiquette delays so the suite is fast and deterministic: replace
    // setTimeout with one that fires the callback synchronously.
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

  it('clean address → pxid + location persisted', async () => {
    const fetchStub = stubFetch({
      postBody: autocomplete_single_match,
      locationHeader: `/questionnaire/${SINGLE_MATCH_LOCATION_ID}/household?address_id=x`,
    });
    const e = env(true);
    const out = await resolveUserAddress(e, 'u-1', '1 Queen Street, Auckland Central, Auckland 1010');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.pxid).toBe('2-.1.6.6.1aoR.');
      expect(out.locationId).toBe(SINGLE_MATCH_LOCATION_ID);
    }
    // two live calls: POST autocomplete + GET questionnaire
    expect(fetchStub.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(fetchStub.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    // identified user agent on every call
    expect(fetchStub.calls.every((c) => c.ua === POWERSWITCH_USER_AGENT)).toBe(true);
    fetchStub.restore();
  });

  it('ambiguous (user gave a unit) → needs_review, no persist', async () => {
    const fetchStub = stubFetch({ postBody: autocomplete_ambiguous_units });
    const e = env(true);
    const db = e.DB as unknown as { __runCount: number };
    const out = await resolveUserAddress(e, 'u-2', '12A Birkdale Road, Birkdale, Auckland 0626');
    expect(out.status).toBe('needs_review');
    expect(db.__runCount).toBe(0); // never persisted a guess
    // questionnaire GET never happened (resolution stopped before location step)
    expect(fetchStub.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    fetchStub.restore();
  });

  it('zero-match → needs_review, no persist', async () => {
    const fetchStub = stubFetch({ postBody: autocomplete_zero_match });
    const e = env(true);
    const db = e.DB as unknown as { __runCount: number };
    const out = await resolveUserAddress(e, 'u-3', '100 Nowhere Street, Nullsville');
    expect(out.status).toBe('needs_review');
    if (out.status === 'needs_review') expect(out.reason).toBe('zero_match');
    expect(db.__runCount).toBe(0);
    fetchStub.restore();
  });

  it('POWERSWITCH_LIVE=false → disabled, no live fetch', async () => {
    const fetchStub = stubFetch({ postBody: autocomplete_single_match });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await resolveUserAddress(env(false), 'u-4', '1 Queen Street');
    expect(out.status).toBe('disabled');
    expect(fetchStub.calls).toHaveLength(0); // zero live calls — INERT
    const logged = logSpy.mock.calls.find((c) => String(c[0]).includes('powerswitch_live_disabled'));
    expect(logged).toBeDefined();
    fetchStub.restore();
    logSpy.mockRestore();
  });

  it('drift response → structured error logged, no persist', async () => {
    const fetchStub = stubFetch({ postBody: autocomplete_drift_response });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env(true);
    const db = e.DB as unknown as { __runCount: number };
    const out = await resolveUserAddress(e, 'u-5', '1 Queen Street');
    expect(out.status).toBe('drift');
    expect(db.__runCount).toBe(0); // never persisted garbage
    const logged = errSpy.mock.calls.find((c) => String(c[0]).includes('powerswitch_drift'));
    expect(logged).toBeDefined();
    fetchStub.restore();
    errSpy.mockRestore();
  });

  it('resolves even when the location header is absent (location id best-effort)', async () => {
    const fetchStub = stubFetch({
      postBody: autocomplete_single_match,
      locationHeader: null,
    });
    const out = await resolveUserAddress(env(true), 'u-6', '1 Queen Street');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.pxid).toBe('2-.1.6.6.1aoR.');
      expect(out.locationId).toBeNull();
    }
    fetchStub.restore();
  });

  it('autocomplete fetch failure → error outcome, no persist', async () => {
    const fetchStub = stubFetch({ postStatus: 500 });
    const out = await resolveUserAddress(env(true), 'u-7', '1 Queen Street');
    expect(out.status).toBe('error');
    fetchStub.restore();
  });
});
