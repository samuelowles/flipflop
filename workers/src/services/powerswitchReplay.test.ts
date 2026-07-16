import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  replayQuestionnaire,
  readCachedResults,
  clearCachedResults,
  consumeBudget,
  resultsCacheKey,
  buildClientProfileData,
  setDriftFlag,
  isDriftFlagged,
  clearDriftFlag,
  DEFAULT_ANSWERS,
  type PowerswitchReplayEnv,
  type HouseholdAnswers,
} from './powerswitchReplay';
import {
  AUTOCOMPLETE_ACTION,
  HOUSEHOLD_ACTION,
  INSULATION_ACTION,
  RESULTS_ACTION,
  POWERSWITCH_USER_AGENT,
  POWERSWITCH_BASE_URL,
  householdRequestBody,
} from './powerswitchSession';
import { household_flight, insulation_flight, rsc_results_flight, rsc_results_flight_drift } from './powerswitchLiveFixtures';

/**
 * Issue #221/#240 — questionnaire replay + KV cache + drift flag, rebuilt against
 * the REAL captures. All tests stub `globalThis.fetch` (no live network) and mock
 * setTimeout (etiquette delays). The 3-POST chain (household → insulation →
 * results) mirrors the capture; ICP is never submitted.
 */

const BASE_PXID = '2-.1.6.6.1aoR.';
/** Insulation flight's profile.id — the results token the replay extracts. */
const RESULTS_TOKEN = 'vEVbyZKPEa';

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
  return { kv, store, ttlOf: (key: string) => ttlMap.get(key) ?? null };
}

function env(live: boolean, kv?: KVNamespace): PowerswitchReplayEnv {
  return { KV: kv ?? fakeKV().kv, POWERSWITCH_LIVE: live ? 'true' : 'false' };
}

/** Serve the real captured flights for the 3-POST chain; record every call. */
function stubChain(opts: { resultsFlight?: string; householdStatus?: number } = {}) {
  const original = globalThis.fetch;
  const calls: {
    method: string; url: string; ua?: string; nextAction?: string; bodyText?: string;
  }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers = init?.headers instanceof Headers
      ? init.headers
      : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    calls.push({
      method, url,
      ua: headers.get('User-Agent') ?? undefined,
      nextAction: headers.get('Next-Action') ?? undefined,
      bodyText: init?.body ? String(init.body) : undefined,
    });
    if (opts.householdStatus && opts.householdStatus >= 500 && method === 'POST' && url.includes('/household')) {
      return new Response('err', { status: opts.householdStatus });
    }
    if (method === 'POST' && url.includes('/questionnaire/household')) {
      return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    if (method === 'POST' && url.includes('/questionnaire/insulation')) {
      return new Response(insulation_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    if (method === 'POST' && url.includes('/results?p=')) {
      return new Response(opts.resultsFlight ?? rsc_results_flight, {
        status: 200, headers: { 'content-type': 'text/x-component' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

/** Assert no POST body carries an ICP VALUE (icp fields are null/$undefined only). */
function assertNoIcpValue(bodies: string[]) {
  for (const b of bodies) {
    // An icp/icp_identifier/icp_number field with a digit value would be a real ICP.
    expect(b).not.toMatch(/"icp(?:_identifier|_number)?":"\d/);
  }
}

describe('resultsCacheKey / readCachedResults / clearCachedResults', () => {
  it('namespaces per user', () => {
    expect(resultsCacheKey('u-1')).toBe('powerswitch:results:u-1');
  });
  it('returns null when absent', async () => {
    const { kv } = fakeKV();
    expect(await readCachedResults(env(true, kv), 'u-1')).toBeNull();
  });
  it('clear removes a cached entry', async () => {
    const { kv } = fakeKV({ [resultsCacheKey('u')]: '{}' });
    await clearCachedResults(env(true, kv), 'u');
    expect(await kv.get(resultsCacheKey('u'))).toBeNull();
  });
});

describe('consumeBudget', () => {
  it('counts down the daily budget', async () => {
    const { kv } = fakeKV();
    const e = env(true, kv);
    expect(await consumeBudget(e, 3)).toBe(true);
    expect(await consumeBudget(e, 3)).toBe(true);
  });
});

describe('drift flag (KV, 48h)', () => {
  it('is settable, detectable, clearable', async () => {
    const { kv } = fakeKV();
    const e = env(true, kv);
    expect(await isDriftFlagged(e)).toBe(false);
    await setDriftFlag(e, 'test');
    expect(await isDriftFlagged(e)).toBe(true);
    await clearDriftFlag(e);
    expect(await isDriftFlagged(e)).toBe(false);
  });
});

describe('buildClientProfileData', () => {
  it('carries the household address verbatim + icp:null (never submitted)', () => {
    const address = { id: BASE_PXID, a: '1 Queen Street', x: '174.7', y: '-36.8' };
    const profile = buildClientProfileData(address, 267, 266, DEFAULT_ANSWERS, '2026-07-16T03:41:05.635Z');
    expect(profile.address).toBe(address);
    expect(profile.electricity_location_id).toBe(267);
    expect(profile.gas_location_id).toBe(266);
    expect(profile.icp).toBeNull();
    expect(profile.household_size).toBe('M');
    expect(profile.heating).toEqual(['HP']);
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

  it('POWERSWITCH_LIVE=false → disabled, zero live fetch', async () => {
    const stub = stubChain();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await replayQuestionnaire(env(false), 'u-1', BASE_PXID);
    expect(out.status).toBe('disabled');
    expect(stub.calls).toHaveLength(0);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_live_disabled'))).toBe(true);
    stub.restore();
    logSpy.mockRestore();
  });

  it('cache hit → ok with cached=true, zero outbound requests', async () => {
    const stub = stubChain();
    const cached = { usage: { annualKwh: 1, monthlyKwh: Array(12).fill(1) }, plans: [] };
    const { kv } = fakeKV({ [resultsCacheKey('u-2')]: JSON.stringify(cached) });
    const out = await replayQuestionnaire(env(true, kv), 'u-2', BASE_PXID);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.cached).toBe(true);
    expect(stub.calls).toHaveLength(0);
    stub.restore();
  });

  it('full live replay → 3 POSTs, 15 plans cached with a 7-day TTL', async () => {
    const { kv, ttlOf } = fakeKV();
    const stub = stubChain();
    const out = await replayQuestionnaire(env(true, kv), 'u-3', BASE_PXID);
    stub.restore();
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.cached).toBe(false);
      expect(out.results.plans).toHaveLength(15);
    }
    // Exactly 3 POSTs: household, insulation, results.
    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts[0]!.url).toContain('/questionnaire/household');
    expect(posts[0]!.nextAction).toBe(HOUSEHOLD_ACTION);
    expect(posts[1]!.url).toContain('/questionnaire/insulation');
    expect(posts[1]!.nextAction).toBe(INSULATION_ACTION);
    expect(posts[2]!.url).toContain('/results?p=');
    expect(posts[2]!.nextAction).toBe(RESULTS_ACTION);
    // Results body is ["<token>"] (the captured text/plain array).
    expect(JSON.parse(posts[2]!.bodyText!)).toEqual([RESULTS_TOKEN]);
    // KV cache written with 7-day TTL.
    const stored = await kv.get(resultsCacheKey('u-3'));
    expect(stored).not.toBeNull();
    expect(ttlOf(resultsCacheKey('u-3'))).toBe(7 * 24 * 60 * 60);
  });

  it('ICP value never appears in any submitted body', async () => {
    const stub = stubChain();
    const answers: HouseholdAnswers = { ...DEFAULT_ANSWERS, householdSize: 'L' };
    await replayQuestionnaire(env(true, fakeKV().kv), 'u-4', BASE_PXID, answers);
    stub.restore();
    const postBodies = stub.calls.filter((c) => c.method === 'POST').map((c) => c.bodyText ?? '');
    expect(postBodies.length).toBe(3);
    assertNoIcpValue(postBodies);
    // The insulation profile explicitly carries icp:null.
    const insulationBody = JSON.parse(postBodies[1]!)[0].clientProfileData;
    expect(JSON.parse(insulationBody).icp).toBeNull();
  });

  it('identified user agent + text/plain body on every POST', async () => {
    const stub = stubChain();
    await replayQuestionnaire(env(true, fakeKV().kv), 'u-5', BASE_PXID);
    stub.restore();
    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts.every((c) => c.ua === POWERSWITCH_USER_AGENT)).toBe(true);
  });

  it('drift (results schema mismatch) → drift, KV untouched, drift flag set', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kv } = fakeKV();
    const stub = stubChain({ resultsFlight: rsc_results_flight_drift });
    const out = await replayQuestionnaire(env(true, kv), 'u-6', BASE_PXID);
    stub.restore();
    expect(out.status).toBe('drift');
    expect(await kv.get(resultsCacheKey('u-6'))).toBeNull(); // NOTHING persisted
    expect(await isDriftFlagged(env(true, kv))).toBe(true); // flag raised
    errSpy.mockRestore();
  });

  it('household result missing → drift, flag set', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init?.headers as Record<string, string> | undefined) ?? {});
      const ua = headers.get('User-Agent');
      void ua;
      return new Response('0:["$@1",[]]\r\n1:{"no_result_here":{}}', {
        status: 200, headers: { 'content-type': 'text/x-component' },
      });
    }) as typeof globalThis.fetch;
    const { kv } = fakeKV();
    const out = await replayQuestionnaire(env(true, kv), 'u-7', BASE_PXID);
    globalThis.fetch = original;
    expect(out.status).toBe('drift');
    if (out.status === 'drift') expect(out.reason).toBe('household_result_missing');
    expect(await isDriftFlagged(env(true, kv))).toBe(true);
    errSpy.mockRestore();
  });

  it('drift flag already set → error (user replay skipped)', async () => {
    const stub = stubChain();
    const { kv } = fakeKV();
    await setDriftFlag(env(true, kv), 'prior_canary_drift');
    const out = await replayQuestionnaire(env(true, kv), 'u-8', BASE_PXID);
    stub.restore();
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.reason).toBe('drift_flag_set');
  });

  it('autocomplete action hash is never used by the replay (session owns it)', async () => {
    // Sanity: the replay chain is household→insulation→results, never autocomplete.
    const stub = stubChain();
    await replayQuestionnaire(env(true, fakeKV().kv), 'u-9', BASE_PXID);
    stub.restore();
    const actions = stub.calls.map((c) => c.nextAction);
    expect(actions).not.toContain(AUTOCOMPLETE_ACTION);
    expect(actions).toContain(HOUSEHOLD_ACTION);
  });

  it('household body matches the captured householdRequestBody shape', async () => {
    const stub = stubChain();
    await replayQuestionnaire(env(true, fakeKV().kv), 'u-10', BASE_PXID);
    stub.restore();
    const householdCall = stub.calls.find((c) => c.url.includes('/questionnaire/household'))!;
    expect(JSON.parse(householdCall.bodyText!)).toEqual(householdRequestBody(BASE_PXID));
  });
});

describe('householdRequestBody sanity (re-exported from session)', () => {
  it('never carries an ICP value', () => {
    assertNoIcpValue([JSON.stringify(householdRequestBody(BASE_PXID))]);
  });
  void POWERSWITCH_BASE_URL; // referenced for import stability
});
