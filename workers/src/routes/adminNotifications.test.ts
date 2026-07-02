import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminListNotifications } from './adminNotifications';
import { adminAuth } from '../middleware/adminAuth';
import * as notificationAudit from '../models/notificationAudit';

const mockList = vi.spyOn(notificationAudit, 'listNotificationAudit');

const ADMIN_API_KEY = 'test-admin-key';

function buildApp(): Hono {
  const app = new Hono();
  // Mirrors index.ts: adminAuth applied to /admin/* before the handler.
  app.use('/admin/*', adminAuth);
  app.get('/admin/notifications', adminListNotifications);
  return app;
}

describe('GET /admin/notifications — auth gate (issue #82 SECURITY)', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('returns 401 without a Bearer header', async () => {
    const app = buildApp();
    const res = await app.request('/admin/notifications', { method: 'GET' }, {
      ADMIN_API_KEY,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong Bearer token', async () => {
    const app = buildApp();
    const res = await app.request('/admin/notifications', {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-key' },
    }, { ADMIN_API_KEY });
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 401 when ADMIN_API_KEY is unset in env', async () => {
    const app = buildApp();
    const res = await app.request('/admin/notifications', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    }, {});
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 200 with paginated audit rows when authed', async () => {
    mockList.mockResolvedValue([
      {
        id: 'a1',
        userId: 'u-1',
        notificationType: 'saving_alert',
        comparisonId: null,
        channel: 'whatsapp',
        template: 'saving_alert',
        sentMessageId: 'msg-1',
        status: 'sent',
        reason: null,
        createdAt: '2026-07-02T03:00:00Z',
      },
    ]);

    const app = buildApp();
    const res = await app.request('/admin/notifications', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    }, { ADMIN_API_KEY, DB: {} as D1Database });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: { id: string; status: string }[];
      limit: number;
      offset: number;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]!.id).toBe('a1');
    expect(body.notifications[0]!.status).toBe('sent');
    expect(body.limit).toBe(50); // default
    expect(body.offset).toBe(0); // default
    expect(mockList).toHaveBeenCalledOnce();
  });
});

describe('GET /admin/notifications — query handling', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue([]);
  });

  it('passes user_id, status, since, limit, offset through to the model', async () => {
    const app = buildApp();
    await app.request(
      '/admin/notifications?user_id=u-9&status=failed&since=2026-06-01&limit=10&offset=5',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, DB: {} as D1Database }
    );

    expect(mockList).toHaveBeenCalledOnce();
    const opts = mockList.mock.calls[0]![1];
    expect(opts).toEqual({
      userId: 'u-9',
      status: 'failed',
      since: '2026-06-01',
      limit: 10,
      offset: 5,
    });
  });

  it('rejects an unknown status with 400', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/notifications?status=bogus',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, DB: {} as D1Database }
    );
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/notifications?limit=abc',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, DB: {} as D1Database }
    );
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
