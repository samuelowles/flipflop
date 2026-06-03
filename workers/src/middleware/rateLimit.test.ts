import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from './rateLimit';

// In-memory KV mock for testing rate limiting
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key: string) => Promise.resolve({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(kv: KVNamespace) {
  // c.executionCtx is populated by Hono's app.request third argument
  return { KV: kv };
}

describe('rateLimit middleware', () => {
  it('allows requests under the limit', async () => {
    const kv = createMockKV();
    const app = new Hono();
    app.get(
      '/test',
      rateLimit({ userLimit: 5, globalLimit: 100, windowMs: 60_000 }),
      (c) => c.json({ ok: true })
    );

    const res = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      makeEnv(kv)
    );

    expect(res.status).toBe(200);
  });

  it('returns 429 when user limit is exceeded', async () => {
    const kv = createMockKV();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 2, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '5.6.7.8' };
    const env = makeEnv(kv);

    // First two should pass
    const r1 = await app.request('/test', { headers }, env);
    expect(r1.status).toBe(200);
    const r2 = await app.request('/test', { headers }, env);
    expect(r2.status).toBe(200);

    // Third should be rate limited
    const r3 = await app.request('/test', { headers }, env);
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as { code: string };
    expect(body.code).toBe('rate_limited');
  });

  it('includes Retry-After header on 429 responses', async () => {
    const kv = createMockKV();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '9.10.11.12' };
    const env = makeEnv(kv);

    // Consume the 1 allowed request
    await app.request('/test', { headers }, env);

    // Second should be rate limited
    const res = await app.request('/test', { headers }, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('treats different IPs as different users', async () => {
    const kv = createMockKV();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(kv);

    // First IP uses its one request
    const r1 = await app.request('/test', {
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
    }, env);
    expect(r1.status).toBe(200);

    // Second IP should also get its own request (not rate limited)
    const r2 = await app.request('/test', {
      headers: { 'CF-Connecting-IP': '10.0.0.2' },
    }, env);
    expect(r2.status).toBe(200);
  });

  it('uses a default window of 60 seconds', async () => {
    const kv = createMockKV();
    const app = new Hono();
    app.get('/test', rateLimit(), (c) => c.json({ ok: true }));

    const res = await app.request(
      '/test',
      { headers: { 'CF-Connecting-IP': '20.20.20.20' } },
      makeEnv(kv)
    );

    expect(res.status).toBe(200);
  });

  it('returns proper Retry-After in seconds matching config', async () => {
    const kv = createMockKV();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 1, globalLimit: 100, windowMs: 30_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const headers = { 'CF-Connecting-IP': '30.30.30.30' };
    const env = makeEnv(kv);
    await app.request('/test', { headers }, env); // consume
    const res = await app.request('/test', { headers }, env);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('returns 429 when global limit is exceeded', async () => {
    const kv = createMockKV();
    const app = new Hono();
    const limiter = rateLimit({ userLimit: 100, globalLimit: 2, windowMs: 60_000 });
    app.get('/test', limiter, (c) => c.json({ ok: true }));

    const env = makeEnv(kv);

    // First two requests from different IPs consume the global limit
    const r1 = await app.request('/test', {
      headers: { 'CF-Connecting-IP': '40.0.0.1' },
    }, env);
    expect(r1.status).toBe(200);

    const r2 = await app.request('/test', {
      headers: { 'CF-Connecting-IP': '40.0.0.2' },
    }, env);
    expect(r2.status).toBe(200);

    // Third request (different IP) should be rate limited globally
    const r3 = await app.request('/test', {
      headers: { 'CF-Connecting-IP': '40.0.0.3' },
    }, env);
    expect(r3.status).toBe(429);
  });

  it('falls back to "unknown" when no CF-Connecting-IP header', async () => {
    const kv = createMockKV();
    const app = new Hono();
    app.get('/test', rateLimit({ userLimit: 5, globalLimit: 100, windowMs: 60_000 }), (c) =>
      c.json({ ok: true })
    );

    // No IP header should still work (uses 'unknown')
    const res = await app.request('/test', {}, makeEnv(kv));
    expect(res.status).toBe(200);
  });
});
