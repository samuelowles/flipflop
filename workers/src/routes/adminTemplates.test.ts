import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminListTemplates, adminTemplateStatus } from './adminTemplates';
import { adminAuth } from '../middleware/adminAuth';
import * as sentTemplates from '../services/sentTemplates';

const mockGetTemplateStatus = vi.spyOn(sentTemplates, 'getTemplateStatus');
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

const ADMIN_API_KEY = 'test-admin-key';

function buildApp(): Hono {
  const app = new Hono();
  // Mirrors index.ts: middleware applied to /admin/* before the handlers.
  app.use('/admin/*', adminAuth);
  app.get('/admin/templates', adminListTemplates);
  app.get('/admin/templates/status', adminTemplateStatus);
  return app;
}

describe('adminListTemplates', () => {
  it('returns the 6 PRD templates with content + variable lists', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY }
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      templates: { name: string; variables: string[] }[];
    };
    expect(body.templates).toHaveLength(6);
    expect(body.templates.map((t) => t.name)).toEqual([
      'bill_received',
      'saving_alert',
      'stay_put',
      'switch_update',
      'fixed_term_expiry',
      'free_tier_checkin',
    ]);
    expect(body.templates[0]!.variables).toEqual([
      'retailer',
      'usage_kwh',
      'days',
      'total_dollars',
    ]);
  });

  it('returns 401 without a Bearer header', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates',
      { method: 'GET' },
      { ADMIN_API_KEY }
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 with a wrong Bearer token', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates',
      { method: 'GET', headers: { Authorization: 'Bearer wrong-key' } },
      { ADMIN_API_KEY }
    );
    expect(res.status).toBe(401);
  });

  it('does not call Sent API (registry is static)', async () => {
    mockGetTemplateStatus.mockReset();
    const app = buildApp();
    await app.request(
      '/admin/templates',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY }
    );
    expect(mockGetTemplateStatus).not.toHaveBeenCalled();
  });
});

describe('adminTemplateStatus', () => {
  beforeEach(() => {
    mockGetTemplateStatus.mockReset();
    consoleLogSpy.mockClear();
  });

  it('returns 401 without a Bearer header', async () => {
    const app = buildApp();
    const res = await app.request(
      '/admin/templates/status',
      { method: 'GET' },
      { ADMIN_API_KEY, SENT_API_KEY: 'test-key' }
    );
    expect(res.status).toBe(401);
  });

  it('returns per-template statuses from Sent', async () => {
    mockGetTemplateStatus.mockImplementation(async (apiKey, name) => {
      const approved = ['bill_received', 'saving_alert'].includes(name);
      return {
        name,
        status: approved ? 'approved' : 'pending',
        lastCheckedAt: '2026-06-29T10:00:00Z',
      };
    });

    const app = buildApp();
    const res = await app.request(
      '/admin/templates/status',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, SENT_API_KEY: 'test-key' }
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      templates: { name: string; status: string }[];
    };
    expect(body.templates).toHaveLength(6);
    const billReceived = body.templates.find((t) => t.name === 'bill_received')!;
    expect(billReceived.status).toBe('approved');
    const stayPut = body.templates.find((t) => t.name === 'stay_put')!;
    expect(stayPut.status).toBe('pending');
  });

  it('surfaces rejectionReason when Sent rejects a template', async () => {
    mockGetTemplateStatus.mockImplementation(async (_apiKey, name) => {
      if (name === 'saving_alert') {
        return {
          name,
          status: 'rejected',
          lastCheckedAt: '2026-06-29T10:00:00Z',
          rejectionReason: 'template contains promotional language',
        };
      }
      return {
        name,
        status: 'approved',
        lastCheckedAt: '2026-06-29T10:00:00Z',
      };
    });

    const app = buildApp();
    const res = await app.request(
      '/admin/templates/status',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, SENT_API_KEY: 'test-key' }
    );
    const body = (await res.json()) as {
      templates: { name: string; status: string; rejectionReason?: string }[];
    };
    const saving = body.templates.find((t) => t.name === 'saving_alert')!;
    expect(saving.status).toBe('rejected');
    expect(saving.rejectionReason).toBe('template contains promotional language');
    const stayPut = body.templates.find((t) => t.name === 'stay_put')!;
    expect(stayPut.rejectionReason).toBeUndefined();
  });

  it('surfaces per-template Sent failures as pending (does not fail the whole request)', async () => {
    mockGetTemplateStatus.mockImplementation(async (_apiKey, name) => {
      if (name === 'switch_update') {
        throw new Error('Sent 500');
      }
      return {
        name,
        status: 'approved',
        lastCheckedAt: '2026-06-29T10:00:00Z',
      };
    });

    const app = buildApp();
    const res = await app.request(
      '/admin/templates/status',
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_API_KEY}` } },
      { ADMIN_API_KEY, SENT_API_KEY: 'test-key' }
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      templates: { name: string; status: string }[];
    };
    const switchUpdate = body.templates.find((t) => t.name === 'switch_update')!;
    expect(switchUpdate.status).toBe('pending');

    // structured log emitted
    expect(consoleLogSpy).toHaveBeenCalled();
    const logged = JSON.stringify(consoleLogSpy.mock.calls) as string;
    expect(logged).toContain('admin_template_status_error');
    expect(logged).toContain('switch_update');
  });
});