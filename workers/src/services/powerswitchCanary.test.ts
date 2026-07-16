import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPowerswitchCanary, canaryFixtureSelfTest, CANARY_FIXTURE_PXID, type CanaryEnv } from './powerswitchCanary';
import { isDriftFlagged, setDriftFlag, resultsCacheKey } from './powerswitchReplay';
import { household_flight, insulation_flight, rsc_results_flight, rsc_results_flight_drift } from './powerswitchLiveFixtures';

/** Issue #240 — the daily drift canary (split from powerswitchReplay). */
function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) { void opts; store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  } as unknown as KVNamespace;
  return { kv, store };
}

function env(live: boolean, kv?: KVNamespace): CanaryEnv {
  return { KV: kv ?? fakeKV().kv, POWERSWITCH_LIVE: live ? 'true' : 'false' };
}

function stubChain(resultsFlight: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.includes('/questionnaire/household')) {
      return new Response(household_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    if (method === 'POST' && url.includes('/questionnaire/insulation')) {
      return new Response(insulation_flight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    if (method === 'POST' && url.includes('/results?p=')) {
      return new Response(resultsFlight, { status: 200, headers: { 'content-type': 'text/x-component' } });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

describe('canaryFixtureSelfTest', () => {
  it('accepts the real flight and rejects the drift flight', () => {
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

  it('POWERSWITCH_LIVE=false → skipped_live_disabled, zero live fetch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const restore = stubChain(rsc_results_flight);
    const out = await runPowerswitchCanary(env(false));
    restore();
    expect(out.status).toBe('skipped_live_disabled');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('canary_skipped_live_disabled'))).toBe(true);
    logSpy.mockRestore();
  });

  it('LIVE canary → ok + drift flag cleared when the chain succeeds', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { kv } = fakeKV();
    await setDriftFlag(env(true, kv), 'preexisting'); // flag set before a healthy run
    const restore = stubChain(rsc_results_flight);
    const out = await runPowerswitchCanary(env(true, kv));
    restore();
    expect(out.status).toBe('ok');
    expect(await isDriftFlagged(env(true, kv))).toBe(false); // cleared on success
    logSpy.mockRestore();
  });

  it('LIVE canary → drift + flag set when the results schema mismatches', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kv } = fakeKV();
    const restore = stubChain(rsc_results_flight_drift);
    const out = await runPowerswitchCanary(env(true, kv));
    restore();
    expect(out.status).toBe('drift');
    expect(await isDriftFlagged(env(true, kv))).toBe(true); // raised on drift
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('powerswitch_canary_drift'))).toBe(true);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('uses the fixture pxid (canary address)', () => {
    expect(CANARY_FIXTURE_PXID).toBe('2-.1.6.6.1aoR.');
    // Sanity: the canary result caches under its own id, not a real user.
    expect(resultsCacheKey('canary-fixture')).toContain('canary-fixture');
  });
});
