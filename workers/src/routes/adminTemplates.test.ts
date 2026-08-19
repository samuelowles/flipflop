import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminListTemplates, adminTemplateStatus, adminSubmitTemplates } from './adminTemplates';
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
const mockSubmitTemplate = vi.spyOn(sentTemplates, 'submitTemplate');

describe('POST /admin/templates/submit (re-registering after a copy change)', () => {
  /**
   * `submitTemplate` had ZERO callers since Epic #2, so the registry could be
   * edited but never re-registered with Sent. #265 corrected `saving_alert`
   * (the amount passed to it is annual, but the body said "3 months" — a 4x
   * overstatement) and the corrected copy had no route to approval.
   */
  // mockReset() alone lets the spy fall through to the real implementation,
  // which then hits the Sent API. Always give it an implementation.
  beforeEach(() => {
    mockSubmitTemplate.mockReset();
    mockSubmitTemplate.mockResolvedValue({ id: 'sub_default', status: 'pending', submittedAt: '2026-08-07T00:00:00Z' });
  });

  function submitApp() {
    const app = new Hono();
    app.post('/admin/templates/submit', adminSubmitTemplates);
    return app;
  }

  const env = { SENT_API_KEY: 'test-key' };

  function ok(id = 'sub_1') {
    return { id, status: 'pending' as const, submittedAt: '2026-08-07T00:00:00Z' };
  }

  it('submits only the named template when names are given', async () => {
    mockSubmitTemplate.mockResolvedValue(ok());

    const res = await submitApp().request(
      '/admin/templates/submit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['saving_alert'] }) },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ name: string; submitted: boolean }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.name).toBe('saving_alert');
    expect(body.results[0]!.submitted).toBe(true);
    expect(mockSubmitTemplate).toHaveBeenCalledTimes(1);
  });

  it('sends the CORRECTED body, which is the entire point', async () => {
    mockSubmitTemplate.mockResolvedValue(ok());
    await submitApp().request(
      '/admin/templates/submit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['saving_alert'] }) },
      env
    );
    const submitted = mockSubmitTemplate.mock.calls[0]![1];
    expect(submitted.content).toContain('12 months');
    expect(submitted.content).not.toContain('3 months');
  });

  it('submits all six when no names are given', async () => {
    mockSubmitTemplate.mockResolvedValue(ok());
    const res = await submitApp().request('/admin/templates/submit', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(mockSubmitTemplate).toHaveBeenCalledTimes(6);
  });

  it('reports per-template so one failure does not hide the rest', async () => {
    mockSubmitTemplate
      .mockRejectedValueOnce(new Error('Sent template submit error (403)'))
      .mockResolvedValue(ok());

    const res = await submitApp().request('/admin/templates/submit', { method: 'POST' }, env);
    expect(res.status, 'partial success is 207, not a blanket 500').toBe(207);
    const body = (await res.json()) as { results: Array<{ submitted: boolean }> };
    expect(body.results.filter((r) => !r.submitted)).toHaveLength(1);
    expect(body.results.filter((r) => r.submitted)).toHaveLength(5);
  });

  it('400s when a known name is mixed with an unknown one, submitting neither', async () => {
    const res = await submitApp().request(
      '/admin/templates/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: ['saving_alert', 'saving_alrt'] }),
      },
      env
    );

    expect(res.status, 'a typo beside a real name must not report success').toBe(400);
    const body = (await res.json()) as { unknown: string[] };
    expect(body.unknown).toEqual(['saving_alrt']);
    expect(mockSubmitTemplate).not.toHaveBeenCalled();
  });

  it('400s on an unknown name rather than silently submitting nothing', async () => {
    const res = await submitApp().request(
      '/admin/templates/submit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['nope'] }) },
      env
    );
    expect(res.status).toBe(400);
    expect(mockSubmitTemplate).not.toHaveBeenCalled();
  });
});
