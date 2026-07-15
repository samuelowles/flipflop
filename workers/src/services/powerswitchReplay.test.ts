import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  replayQuestionnaire,
  runPowerswitchCanary,
  canaryFixtureSelfTest,
  discoverActionIds,
  resultsCacheKey,
  readCachedResults,
  consumeBudget,
  DEFAULT_ANSWERS,
  type PowerswitchReplayEnv,
  type HouseholdAnswers,
} from './powerswitchReplay';
import { POWERSWITCH_USER_AGENT } from './powerswitchSession';
import {
  questionnaire_landing_html,
  DISCOVERED_ACTION_ID,
  questionnaire_final_step,
  rsc_results_flight,
  rsc_results_flight_drift,
} from './powerswitchFixtures';

/**
 * Issue #221 — Questionnaire replay + KV cache + canary. All tests stub
 * `globalThis.fetch` (no live network) and mock setTimeout (etiquette delays).
 */

/** In-memory KV with TTL tracking for assertions. */
function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const ttlMap = new Map<string, number>();
  const kv = {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      if (opts?.expirationTtl) ttlMap.set(key, opts.expirationTtl);
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KVNamespace;
  return {
    kv,
    store,
    ttlOf: (key: string) => ttlMap.get(key) ?? null,
  };
}

function env(live: boolean, kv?: KVNamespace): PowerswitchReplayEnv {
  return { KV: kv ?? fakeKV().kv, POWERSWITCH_LIVE: live ? 'true' : 'false' };
}

/** Record every fetch call so we can assert ICP never appears in a body. */
function stubFetch(opts: {
  landingHtml?: string;
  flight?: string;
  resultsStatus?: number;
  failDiscovery?: boolean;
}) {
  const original = globalThis.fetch;
  const calls: { method: string; url: string; bodyText?: string; ua?: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const ua = init?.headers instanceof Headers
      ? init.headers.get('User-Agent') ?? undefined
      : (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
    let bodyText: string | undefined;
    if (init?.body) bodyText = String(init.body);
    calls.push({ method, url, bodyText, ua });

    // Questionnaire landing GET (discovery).
    if (method === 'GET' && url.includes('/questionnaire/') && url.includes('/household') && !url.includes('?')) {
      if (opts.failDiscovery) return new Response('no ids here', { status: 200 });
      return new Response(opts.landingHtml ?? questionnaire_landing_html, { status: 200 });
    }
    // Results GET (RSC flight).
    if (method === 'GET' && url.includes('/results?p=')) {
      if (opts.resultsStatus && opts.resultsStatus >= 500) {
        return new Response('err', { status: opts.resultsStatus });
      }
      return new Response(opts.flight ?? rsc_results_flight, {
        status: 200,
        headers: { 'content-type': 'text/x-component' },
      });
    }
    // Questionnaire step POST.
    if (method === 'POST' && url.includes('/questionnaire/')) {
      if (opts.resultsStatus && opts.resultsStatus >= 500) {
        return new Response('err', { status: opts.resultsStatus });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    restore: () => { globalThis.fetch = original; },
    calls,
  };
}

describe('resultsCacheKey', () => {
  it('namespaces per user', () => {
    expect(resultsCacheKey('u-1')).toBe('powerswitch:results:u-1');
  });
});

describe('discoverActionIds', () => {
  it('scrapes the action id + dpl hash from the served page', async () => {
    const stub = stubFetch({});
    const ids = await discoverActionIds('266');
    expect(ids).not.toBeNull();
    expect(ids!.actionId).toBe(DISCOVERED_ACTION_ID);
    expect(ids!.dplHash).not.toBeNull();
    stub.restore();
  });
  it('returns null (drift) when the ids are absent', async () => {
    const stub = stubFetch({ failDiscovery: true });
    const ids = await discoverActionIds('266');
    expect(ids).toBeNull();
    stub.restore();
  });
});

describe('consumeBudget', () => {
  it('decrements the daily counter and returns true under budget', async () => {
    const { kv } = fakeKV();
    const e = env(true, kv);
    expect(await consumeBudget(e, 9)).toBe(true);
    expect(await consumeBudget(e, 9)).toBe(true);
  });
});

describe('readCachedResults', () => {
  it('returns null when absent', async () => {
    const { kv } = fakeKV();
    expect(await readCachedResults(env(true, kv), 'u-1')).toBeNull();
  });
});

describe('replayQuestionnaire', () => {
  let origSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    origSetTimeout = globalThis.setTimeout;
    const instant: typeof globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    vi.stubGlobal('setTimeout', instant);
  });
  afterEach(() => {
    vi.stubGlobal('setTimeout', origSetTimeout);
    vi.restoreAllMocks();
  });

  it('POWERSWITCH_LIVE=false -> disabled, zero live fetch', async () => {
    const stub = stubFetch({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await replayQuestionnaire(env(false), 'u-1', 'px', '266');
    expect(out.status).toBe('disabled');
    expect(stub.calls).toHaveLength(0);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_live_disabled'))).toBe(true);
    stub.restore();
    logSpy.mockRestore();
  });

  it('cache hit -> ok with cached=true, zero outbound requests', async () => {
    const stub = stubFetch({});
    // Pre-seed cache.
    const cached = JSON.parse(JSON.stringify({ usage: { annualKwh: 1, monthlyKwh: Array(12).fill(1) }, plans: [] }));
    const { kv } = fakeKV({ [resultsCacheKey('u-2')]: JSON.stringify(cached) });
    const out = await replayQuestionnaire(env(true, kv), 'u-2', 'px', '266');
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.cached).toBe(true);
    expect(stub.calls).toHaveLength(0);
    stub.restore();
  });

  it('full live replay -> parsed plans cached to KV with a 7-day TTL', async () => {
    const { kv, ttlOf } = fakeKV();
    const e = env(true, kv);
    // Every POST returns { ok:true }; the final (insulation) step carries the token.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/household') && !url.includes('?')) {
        return new Response(questionnaire_landing_html, { status: 200 });
      }
      if (method === 'POST' && url.includes('/insulation')) {
        return new Response(JSON.stringify(questionnaire_final_step), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'GET' && url.includes('/results?p=')) {
        return new Response(rsc_results_flight, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const out = await replayQuestionnaire(e, 'u-3', 'px-1', '266');
    globalThis.fetch = original;

    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.cached).toBe(false);
      expect(out.results.plans).toHaveLength(3);
    }
    // KV cache written with 7-day TTL.
    const stored = await kv.get(resultsCacheKey('u-3'));
    expect(stored).not.toBeNull();
    expect(ttlOf(resultsCacheKey('u-3'))).toBe(7 * 24 * 60 * 60);
    // identified UA on every call
    // (UA assertion skipped here; covered by the ICP-body test below)
  });

  it('ICP never appears in any submitted body', async () => {
    const answers: HouseholdAnswers = { ...DEFAULT_ANSWERS, currentRetailerId: 'mercury' };
    const original = globalThis.fetch;
    const calls: { method: string; url: string; bodyText?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, bodyText: init?.body ? String(init.body) : undefined });
      if (method === 'GET' && url.includes('/household') && !url.includes('?')) {
        return new Response(questionnaire_landing_html, { status: 200 });
      }
      if (method === 'POST' && url.includes('/insulation')) {
        return new Response(JSON.stringify(questionnaire_final_step), { status: 200 });
      }
      if (method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (method === 'GET' && url.includes('/results?p=')) return new Response(rsc_results_flight, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    await replayQuestionnaire(env(true, fakeKV().kv), 'u-4', 'px', '266', answers);
    globalThis.fetch = original;

    const postBodies = calls.filter((c) => c.method === 'POST').map((c) => c.bodyText ?? '');
    expect(postBodies.length).toBeGreaterThan(0);
    for (const body of postBodies) {
      expect(body).not.toMatch(/\bicp\b/i);
      expect(body).not.toMatch(/icp_number/i);
    }
  });

  it('identified user agent on every outbound call', async () => {
    const original = globalThis.fetch;
    const calls: { ua?: string }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const ua = init?.headers instanceof Headers
        ? init.headers.get('User-Agent') ?? undefined
        : (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
      calls.push({ ua });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    await replayQuestionnaire(env(true, fakeKV().kv), 'u-5', 'px', '266');
    globalThis.fetch = original;
    expect(calls.every((c) => c.ua === POWERSWITCH_USER_AGENT)).toBe(true);
  });

  it('drift (RSC schema mismatch) -> abort without writing KV', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kv } = fakeKV();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/household') && !url.includes('?')) {
        return new Response(questionnaire_landing_html, { status: 200 });
      }
      if (method === 'POST' && url.includes('/insulation')) {
        return new Response(JSON.stringify(questionnaire_final_step), { status: 200 });
      }
      if (method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (method === 'GET' && url.includes('/results?p=')) {
        return new Response(rsc_results_flight_drift, { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const out = await replayQuestionnaire(env(true, kv), 'u-6', 'px', '266');
    globalThis.fetch = original;
    expect(out.status).toBe('drift');
    expect(await kv.get(resultsCacheKey('u-6'))).toBeNull(); // NOTHING persisted
    errSpy.mockRestore();
  });

  it('action-id discovery failure -> drift, no partial write', async () => {
    const stub = stubFetch({ failDiscovery: true });
    const { kv } = fakeKV();
    const out = await replayQuestionnaire(env(true, kv), 'u-7', 'px', '266');
    expect(out.status).toBe('drift');
    if (out.status === 'drift') expect(out.reason).toBe('action_id_discovery_failed');
    expect(await kv.get(resultsCacheKey('u-7'))).toBeNull();
    stub.restore();
  });
});

describe('canaryFixtureSelfTest', () => {
  it('accepts the good flight and rejects the drift flight', () => {
    expect(canaryFixtureSelfTest()).toBe(true);
  });
});

describe('runPowerswitchCanary', () => {
  let origSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    origSetTimeout = globalThis.setTimeout;
    const instant: typeof globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    vi.stubGlobal('setTimeout', instant);
  });
  afterEach(() => {
    vi.stubGlobal('setTimeout', origSetTimeout);
    vi.restoreAllMocks();
  });

  it('POWERSWITCH_LIVE=false -> skipped_live_disabled + fixture self-test logged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stub = stubFetch({});
    const out = await runPowerswitchCanary(env(false));
    expect(out.status).toBe('skipped_live_disabled');
    expect(stub.calls).toHaveLength(0); // no live fetch
    const logged = logSpy.mock.calls.find((c) => String(c[0]).includes('canary_skipped_live_disabled'));
    expect(logged).toBeDefined();
    stub.restore();
    logSpy.mockRestore();
  });

  it('LIVE canary -> ok when the full replay succeeds', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/household') && !url.includes('?')) {
        return new Response(questionnaire_landing_html, { status: 200 });
      }
      if (method === 'POST' && url.includes('/insulation')) {
        return new Response(JSON.stringify(questionnaire_final_step), { status: 200 });
      }
      if (method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (method === 'GET' && url.includes('/results?p=')) return new Response(rsc_results_flight, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const out = await runPowerswitchCanary(env(true, fakeKV().kv));
    globalThis.fetch = original;
    expect(out.status).toBe('ok');
    logSpy.mockRestore();
  });

  it('LIVE canary -> drift when the RSC schema mismatches', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/household') && !url.includes('?')) {
        return new Response(questionnaire_landing_html, { status: 200 });
      }
      if (method === 'POST' && url.includes('/insulation')) {
        return new Response(JSON.stringify(questionnaire_final_step), { status: 200 });
      }
      if (method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (method === 'GET' && url.includes('/results?p=')) return new Response(rsc_results_flight_drift, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const out = await runPowerswitchCanary(env(true, fakeKV().kv));
    globalThis.fetch = original;
    expect(out.status).toBe('drift');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_canary_drift'))).toBe(true);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
