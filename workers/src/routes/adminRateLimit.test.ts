import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { adminRateLimitStatus } from './adminRateLimit';

// Reuses the in-memory DO stub shape from rateLimit.test.ts so the admin
// endpoint is exercised against the real sliding-window read logic.
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

        // /check appends so we can populate state before reading.
        if (active.length < body.limit) {
          active.push(body.now);
          stores.set(body.key, active);
        }
        return Response.json({
          limited: active.length >= body.limit,
          remaining: Math.max(0, body.limit - active.length),
          retryAfterMs: 0,
        });
      },
    }),
  };
}

function buildApp(stub: ReturnType<typeof createMockDurableObjectNamespace>) {
  const app = new Hono();
  app.get('/admin/rate-limit/:userKey', adminRateLimitStatus);
  return { app, env: { ADMIN_API_KEY: 'test-admin-key', RATE_LIMITER: stub } };
}

describe('adminRateLimitStatus', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns 401 without ADMIN_API_KEY Authorization Bearer header', async () => {
    const stub = createMockDurableObjectNamespace();
    const { app, env } = buildApp(stub);

    const res = await app.request(
      '/admin/rate-limit/somekey',
      { method: 'GET' },
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 with a wrong Bearer token', async () => {
    const stub = createMockDurableObjectNamespace();
    const { app, env } = buildApp(stub);

    const res = await app.request(
      '/admin/rate-limit/somekey',
      { method: 'GET', headers: { Authorization: 'Bearer wrong-key' } },
      env
    );
    expect(res.status).toBe(401);
  });

  it('returns the current count/window for a user key when authed', async () => {
    const stub = createMockDurableObjectNamespace();
    const { app, env } = buildApp(stub);

    // Seed the DO with 3 requests on the same key.
    const userKey = 'a'.repeat(64);
    const doId = stub.idFromName(userKey);
    const doStub = stub.get(doId);
    for (let i = 0; i < 3; i++) {
      await doStub.fetch(
        new Request('https://rate-limiter/check', {
          method: 'POST',
          body: JSON.stringify({
            key: userKey,
            limit: 100,
            windowMs: 60_000,
            now: Date.now(),
          }),
        })
      );
    }

    const res = await app.request(
      `/admin/rate-limit/${userKey}`,
      { method: 'GET', headers: { Authorization: 'Bearer test-admin-key' } },
      env
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      userKey: string;
      count: number;
      limit: number;
      windowMs: number;
      remaining: number;
      oldestAt: number | null;
    };
    expect(body.userKey).toBe(userKey);
    expect(body.count).toBe(3);
    expect(body.limit).toBe(100);
    expect(body.windowMs).toBe(60_000);
    expect(body.remaining).toBe(97);
    expect(body.oldestAt).not.toBeNull();
  });

  it('returns count=0 for an unseen key when authed', async () => {
    const stub = createMockDurableObjectNamespace();
    const { app, env } = buildApp(stub);

    const res = await app.request(
      '/admin/rate-limit/unseenkey',
      { method: 'GET', headers: { Authorization: 'Bearer test-admin-key' } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; oldestAt: number | null };
    expect(body.count).toBe(0);
    expect(body.oldestAt).toBeNull();
  });

  it('does not mutate the window when reading status', async () => {
    const stub = createMockDurableObjectNamespace();
    const { app, env } = buildApp(stub);

    const userKey = 'b'.repeat(64);
    // No prior /check calls — reading status twice must keep count at 0.
    const headers = { Authorization: 'Bearer test-admin-key' };
    const r1 = await app.request(
      `/admin/rate-limit/${userKey}`,
      { method: 'GET', headers },
      env
    );
    const r2 = await app.request(
      `/admin/rate-limit/${userKey}`,
      { method: 'GET', headers },
      env
    );
    expect(((await r1.json()) as { count: number }).count).toBe(0);
    expect(((await r2.json()) as { count: number }).count).toBe(0);
  });
});
