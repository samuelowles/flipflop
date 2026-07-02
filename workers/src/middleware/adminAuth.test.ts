import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { adminAuth } from './adminAuth';

const ADMIN_API_KEY = 'test-admin-key';

function buildApp(): Hono {
  const app = new Hono();
  app.use('/admin/*', adminAuth);
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/admin/templates', (c) => c.json({ ok: true }));
  return app;
}

describe('adminAuth middleware', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('does NOT gate non-admin routes (/health returns 200 with no Bearer header)', async () => {
    const app = buildApp();
    const res = await app.request('/health', { method: 'GET' }, { ADMIN_API_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('gates /admin/* — returns 401 without a Bearer header', async () => {
    const app = buildApp();
    const res = await app.request('/admin/templates', { method: 'GET' }, { ADMIN_API_KEY });
    expect(res.status).toBe(401);
  });

  it('allows /admin/* with a valid Bearer header', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY }
    );
    expect(res.status).toBe(200);
  });

  it('returns 401 when ADMIN_API_KEY is unset', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      {}
    );
    expect(res.status).toBe(401);
  });
});
