import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, RATE_LIMIT_MESSAGE } from './rateLimit';
import { RateLimiter } from '../durable-objects/RateLimiter';

// In-memory Durable Object stub for testing.  Replays the real DO logic
// (filter expired timestamps, check limit, append) so tests exercise the
// exact same atomicity contract that production uses.  Also implements the
// `/status` read path so admin-endpoint tests can reuse this stub.
function createMockDurableObjectNamespace() {
  const stores = new Map<string, number[]>();
  return {
    idFromName: (key: string) => ({ toString: () => key }),
    get: (_id: { toString: () => string }) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const body = (await req.json()) as {
          key: string;
          limit: number;
          windowMs: number;
          now: number;
        };
        const cutoff = body.now - body.windowMs;
        const stored = stores.get(body.key) ?? [];
        const active = stored.filter((t) => t > cutoff);

        if (url.pathname === '/status') {
          return Response.json({
            count: active.length,
            limit: body.limit,
            windowMs: body.windowMs,
            remaining: Math.max(0, body.limit - active.length),
            oldestAt: active.length > 0 ? active[0] : null,
          });
        }

        // /check (default)
        if (active.length >= body.limit) {
          const oldest = active[0] as number;
          return Response.json({
            limited: true,
            remaining: 0,
            retryAfterMs: Math.max(0, oldest + body.windowMs - body.now),
          });
        }
        active.push(body.now);
        stores.set(body.key, active);
        return Response.json({
          limited: false,
          remaining: Math.max(0, body.limit - active.length),
          retryAfterMs: 0,
        });
      },
    }),
    __peek: (key: string) => stores.get(key) ?? [],
  };
}

function makeEnv(stub: ReturnType<typeof createMockDurableObjectNamespace>) {
  return { RATE_LIMITER: stub };
}

describe('rateLimit middleware', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('allows requests under the limit', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    app.get(
      '/test',
      rateLimit({ userLimit: 5, globalLimit: 100, windowMs: 60_000 }),
      (c) => c.json({ ok: true })
    );

    const res = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      makeEnv(stub) as unknown as object
    );
    expect(res.status).toBe(200);
  });

  it('returns 429 when user limit is exceeded', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 2, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '5.6.7.8' };
    const env = makeEnv(stub) as unknown as object;

    const r1 = await app.request('/test', { headers }, env);
    expect(r1.status).toBe(200);
    const r2 = await app.request('/test', { headers }, env);
    expect(r2.status).toBe(200);
    const r3 = await app.request('/test', { headers }, env);
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as {
      error: string;
      message: string;
      retry_after: number;
    };
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retry_after).toBe('number');
    // Issue #37 AC #2: friendly throttle message in the 429 body.
    expect(body.message).toBe(RATE_LIMIT_MESSAGE);
    expect(body.message).toBe("I'm getting a lot of messages — give me a moment.");
  });

  it('includes Retry-After header on 429 responses', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '9.10.11.12' };
    const env = makeEnv(stub) as unknown as object;

    await app.request('/test', { headers }, env);
    const res = await app.request('/test', { headers }, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('treats different IPs as different users (hashed)', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(stub) as unknown as object;

    const r1 = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '10.0.0.1' } },
      env
    );
    expect(r1.status).toBe(200);

    const r2 = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '10.0.0.2' } },
      env
    );
    expect(r2.status).toBe(200);
  });

  it('uses a default window of 60 seconds', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    app.get('/test', rateLimit(), (c) => c.json({ ok: true }));

    const res = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '20.20.20.20' } },
      makeEnv(stub) as unknown as object
    );
    expect(res.status).toBe(200);
  });

  it('returns proper Retry-After in seconds matching config', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 30_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '30.30.30.30' };
    const env = makeEnv(stub) as unknown as object;
    await app.request('/test', { headers }, env);
    const res = await app.request('/test', { headers }, env);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('returns 429 when global limit is exceeded', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 100, globalLimit: 2, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(stub) as unknown as object;

    const r1 = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '40.0.0.1' } },
      env
    );
    expect(r1.status).toBe(200);

    const r2 = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '40.0.0.2' } },
      env
    );
    expect(r2.status).toBe(200);

    const r3 = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '40.0.0.3' } },
      env
    );
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('falls back to "unknown" when no CF-Connecting-IP header', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    app.get(
      '/test',
      rateLimit({ userLimit: 5, globalLimit: 100, windowMs: 60_000 }),
      (c) => c.json({ ok: true })
    );

    const res = await app.request(
      '/test',
      {},
      makeEnv(stub) as unknown as object
    );
    expect(res.status).toBe(200);
  });

  it('bypasses rate limiting for /health, /healthz, /ready', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/health', limiter, (c) => c.json({ ok: true }));
    app.get('/healthz', limiter, (c) => c.json({ ok: true }));
    app.get('/ready', limiter, (c) => c.json({ ok: true }));
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(stub) as unknown as object;
    const headers = { 'CF-Connecting-IP': '60.60.60.60' };

    for (let i = 0; i < 5; i++) {
      expect((await app.request('/health', { headers }, env)).status).toBe(200);
      expect((await app.request('/healthz', { headers }, env)).status).toBe(200);
      expect((await app.request('/ready', { headers }, env)).status).toBe(200);
    }

    expect((await app.request('/test', { headers }, env)).status).toBe(200);
    expect((await app.request('/test', { headers }, env)).status).toBe(429);
  });

  it('logs the limit hit with scope and id_hash, but never the body or raw IP', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '70.70.70.70' };
    const env = makeEnv(stub) as unknown as object;

    await app.request('/test', { headers }, env);
    const res = await app.request('/test', { headers }, env);
    expect(res.status).toBe(429);

    const logCalls = logSpy.mock.calls.flat();
    const hitLog = logCalls
      .map((s) => {
        try {
          return JSON.parse(String(s));
        } catch {
          return null;
        }
      })
      .find((o): o is Record<string, unknown> => !!o && o.type === 'rate_limit_hit');

    expect(hitLog).toBeDefined();
    if (!hitLog) return;
    expect(hitLog.scope).toBe('user');
    expect(typeof hitLog.id_hash).toBe('string');
    // AC: must NOT log the raw IP (PII) or the response body.
    expect(JSON.stringify(hitLog)).not.toContain('70.70.70.70');
    expect(JSON.stringify(hitLog)).not.toContain('rate_limited');
  });

  // ---- NEW: phone_hash contract from PR #150 ----
  it('uses phone_hash from context when set (by sentAuth)', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    // Inject phone_hash via a synthetic upstream middleware (simulates
    // sentAuth having populated the context).
    const fakeHash = 'a'.repeat(64);
    app.use('*', async (c, next) => {
      (c.set as (k: string, v: unknown) => void).call(c, 'phone_hash', fakeHash);
      await next();
    });

    const env = makeEnv(stub) as unknown as object;
    const r1 = await app.request('/test', {}, env);
    expect(r1.status).toBe(200);

    // Second request on the same phone_hash hits the limit.
    const r2 = await app.request('/test', {}, env);
    expect(r2.status).toBe(429);
  });

  // ---- NEW: fail-closed on missing DO binding ----
  it('returns 503 when RATE_LIMITER Durable Object binding is missing', async () => {
    const app = new Hono();
    app.get(
      '/test',
      rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 }),
      (c) => c.json({ ok: true })
    );

    // Env intentionally has no RATE_LIMITER binding.
    const res = await app.request('/test', {}, {} as unknown as object);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limit_unavailable');
  });

  // ---- NEW: atomicity contract — DO serialises per-key writes ----
  it('atomicity: concurrent requests on the same key cannot both pass the limit', async () => {
    const stub = createMockDurableObjectNamespace();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 3, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(stub) as unknown as object;
    const headers = { 'CF-Connecting-IP': '90.90.90.90' };

    // Fire 5 concurrent requests at a limit of 3 — exactly 3 should pass.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.request('/test', { headers }, env))
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });
});

describe('RateLimiter Durable Object', () => {
  it('rejects unknown paths', async () => {
    // Construct directly with a stub DurableObjectState.
    const state = {
      storage: {
        get: async () => undefined,
        put: async () => undefined,
      },
    } as unknown as DurableObjectState;
    const doStub = new RateLimiter(state, {});
    const res = await doStub.fetch(new Request('https://rate-limiter/unknown'));
    expect(res.status).toBe(404);
  });

  it('allows requests under the limit and trims old timestamps', async () => {
    const store = new Map<string, number[]>();
    const state = {
      storage: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        put: async (key: string, value: number[]) => {
          store.set(key, value);
        },
      },
    } as unknown as DurableObjectState;
    const doStub = new RateLimiter(state, {});

    const now = 1_000_000;
    const res1 = await doStub.fetch(
      new Request('https://rate-limiter/check', {
        method: 'POST',
        body: JSON.stringify({ key: 'k1', limit: 3, windowMs: 1000, now }),
      })
    );
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { limited: boolean }).limited).toBe(false);

    // Advance time past the window — old timestamp should be trimmed.
    const later = now + 1500;
    const res2 = await doStub.fetch(
      new Request('https://rate-limiter/check', {
        method: 'POST',
        body: JSON.stringify({ key: 'k1', limit: 3, windowMs: 1000, now: later }),
      })
    );
    expect(((await res2.json()) as { limited: boolean }).limited).toBe(false);
  });

  it('returns retryAfterMs when over the limit', async () => {
    const store = new Map<string, number[]>();
    const state = {
      storage: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        put: async (key: string, value: number[]) => {
          store.set(key, value);
        },
      },
    } as unknown as DurableObjectState;
    const doStub = new RateLimiter(state, {});

    const now = 1_000_000;
    const windowMs = 1000;
    // Fill the limit (3) with timestamps 100, 200, 300 ms ago.
    for (const delta of [100, 200, 300]) {
      const r = await doStub.fetch(
        new Request('https://rate-limiter/check', {
          method: 'POST',
          body: JSON.stringify({
            key: 'k1',
            limit: 3,
            windowMs,
            now: now - delta,
          }),
        })
      );
      expect(r.status).toBe(200);
    }
    // 4th request at `now` should be limited with retryAfter ~= 700ms.
    const r = await doStub.fetch(
      new Request('https://rate-limiter/check', {
        method: 'POST',
        body: JSON.stringify({ key: 'k1', limit: 3, windowMs, now }),
      })
    );
    const body = (await r.json()) as { limited: boolean; retryAfterMs: number };
    expect(body.limited).toBe(true);
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(windowMs);
  });

  // Issue #37 AC #4: DO exposes a read-only `/status` for admin visibility.
  // Verifies (a) count/remaining/oldestAt reflect prior /check appends, (b)
  // /status itself does NOT append, and (c) an unseen key reports count=0.
  it('reports current window via /status without mutating (seeded + unseen)', async () => {
    const store = new Map<string, number[]>();
    const mkDo = () =>
      new RateLimiter(
        {
          storage: {
            get: async <T>(k: string) => store.get(k) as T | undefined,
            put: async (k: string, v: number[]) => {
              store.set(k, v);
            },
          },
        } as unknown as DurableObjectState,
        {}
      );
    const post = (path: string, body: Record<string, unknown>) =>
      new Request(`https://rate-limiter${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

    const now = 5_000_000;
    const windowMs = 60_000;
    const limit = 100;
    const seeded = mkDo();

    // Seed two /check calls (these append).
    for (let i = 0; i < 2; i++) {
      await seeded.fetch(post('/check', { key: 'admin-view', limit, windowMs, now }));
    }

    const status = (await (await seeded.fetch(post('/status', { key: 'admin-view', limit, windowMs, now }))).json()) as {
      count: number;
      remaining: number;
      oldestAt: number | null;
    };
    expect(status.count).toBe(2);
    expect(status.remaining).toBe(98);
    expect(status.oldestAt).toBe(now);

    // /status must NOT append: a second read still shows count=2.
    const status2 = (await (await seeded.fetch(post('/status', { key: 'admin-view', limit, windowMs, now }))).json()) as { count: number };
    expect(status2.count).toBe(2);

    // Unseen key: count=0, oldestAt=null.
    const unseen = (await (await mkDo().fetch(post('/status', { key: 'never-seen', limit: 100, windowMs: 60_000, now: 1_000_000 }))).json()) as { count: number; oldestAt: number | null };
    expect(unseen.count).toBe(0);
    expect(unseen.oldestAt).toBeNull();
  });
});