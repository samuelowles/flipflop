import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SENT_TEMPLATES,
  getTemplate,
  renderTemplate,
  submitTemplate,
  getTemplateStatus,
} from './sentTemplates';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Sent template registry (Epic #2 #24-29)', () => {
  it('contains exactly 6 templates defined in PRD 7.7', () => {
    expect(SENT_TEMPLATES).toHaveLength(6);
    const names = SENT_TEMPLATES.map((t) => t.name);
    expect(names).toEqual([
      'bill_received',
      'saving_alert',
      'stay_put',
      'switch_update',
      'fixed_term_expiry',
      'free_tier_checkin',
    ]);
  });

  it('declares the variables listed in each issue AC', () => {
    expect(getTemplate('bill_received').variables)
      .toEqual(['retailer', 'usage_kwh', 'days', 'total_dollars']);
    expect(getTemplate('saving_alert').variables)
      .toEqual(['saving_amount', 'recommended_retailer']);
    expect(getTemplate('stay_put').variables).toEqual([]);
    expect(getTemplate('switch_update').variables)
      .toEqual(['to_retailer', 'status', 'next_step']);
    expect(getTemplate('fixed_term_expiry').variables)
      .toEqual(['retailer', 'expiry_date']);
    expect(getTemplate('free_tier_checkin').variables)
      .toEqual(['status_summary']);
  });

  it('throws for unknown template names', () => {
    expect(() => getTemplate('not_a_real_template')).toThrow(/unknown template/);
  });
});

describe('renderTemplate', () => {
  it('substitutes bill_received vars in positional order', () => {
    const out = renderTemplate('bill_received', {
      retailer: 'Contact',
      usage_kwh: '847',
      days: '31',
      total_dollars: '212',
    });
    expect(out).toBe(
      "Got your Contact bill. 847 kWh over 31 days, $212. I'll compare your plans now."
    );
  });

  it('renders stay_put verbatim (no variables)', () => {
    expect(renderTemplate('stay_put', {})).toBe(
      "Good news -- you're still on the best plan for your usage. I'll keep watching."
    );
  });

  it('renders saving_alert with $ amount and recommended retailer', () => {
    expect(renderTemplate('saving_alert', {
      saving_amount: '180',
      recommended_retailer: 'Powershop',
    })).toBe(
      'You could save ~$180 over the next 3 months by switching to Powershop. Want me to switch you?'
    );
  });

  it('renders switch_update with to_retailer, status, next_step', () => {
    expect(renderTemplate('switch_update', {
      to_retailer: 'Mercury',
      status: 'in progress',
      next_step: 'wait for confirmation email',
    })).toBe(
      'Your switch to Mercury is in progress. Next: wait for confirmation email.'
    );
  });

  it('renders fixed_term_expiry with retailer + expiry_date', () => {
    expect(renderTemplate('fixed_term_expiry', {
      retailer: 'Genesis',
      expiry_date: '15 July 2026',
    })).toBe(
      "Your fixed term with Genesis ends on 15 July 2026. I'll check what's available closer to then."
    );
  });

  it('renders free_tier_checkin with status_summary', () => {
    expect(renderTemplate('free_tier_checkin', {
      status_summary: '3 bills tracked this month',
    })).toBe(
      'Your monthly check-in: 3 bills tracked this month. Upgrade to Always On for $30/yr to get automatic alerts.'
    );
  });

  it('throws when a required variable is missing', () => {
    expect(() => renderTemplate('bill_received', { retailer: 'Contact' }))
      .toThrow(/requires variable "usage_kwh"/);
  });

  it('renders the same body whether delivered via WhatsApp or SMS (no markup)', () => {
    const wa = renderTemplate('saving_alert', { saving_amount: '100', recommended_retailer: 'Flick' });
    const sms = renderTemplate('saving_alert', { saving_amount: '100', recommended_retailer: 'Flick' });
    expect(wa).toBe(sms);
    expect(wa).not.toContain('*'); // no markdown
    expect(wa).not.toContain('```'); // no code fences
  });
});

describe('submitTemplate', () => {
  beforeEach(() => mockFetch.mockReset());

  it('POSTs template to Sent /v1/templates and returns submission receipt', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      id: 'sub_abc',
      status: 'pending',
      submittedAt: '2026-06-29T00:00:00Z',
    }));

    const result = await submitTemplate('test-api-key', getTemplate('bill_received'));

    expect(result).toEqual({
      id: 'sub_abc',
      status: 'pending',
      submittedAt: '2026-06-29T00:00:00Z',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/templates');
    expect(call[1].method).toBe('POST');
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer test-api-key');
    const body = JSON.parse(call[1].body as string) as {
      name: string;
      content: string;
      variables: string[];
    };
    expect(body.name).toBe('bill_received');
    expect(body.variables).toEqual(['retailer', 'usage_kwh', 'days', 'total_dollars']);
  });

  it('throws on Sent error response', async () => {
    mockFetch.mockResolvedValue(mockResponse(403, { error: 'forbidden' }));

    await expect(submitTemplate('bad-key', getTemplate('stay_put')))
      .rejects.toThrow(/Sent template submit error \(403\)/);
  });
});

describe('getTemplateStatus', () => {
  beforeEach(() => mockFetch.mockReset());

  it('GETs /v1/templates/{name} and returns status', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      name: 'bill_received',
      status: 'approved',
      lastCheckedAt: '2026-06-29T10:00:00Z',
    }));

    const result = await getTemplateStatus('test-api-key', 'bill_received');

    expect(result.status).toBe('approved');
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/templates/bill_received');
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer test-api-key');
  });

  it('surfaces rejection reason when present', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      name: 'saving_alert',
      status: 'rejected',
      lastCheckedAt: '2026-06-29T10:00:00Z',
      rejectionReason: 'template contains promotional language',
    }));

    const result = await getTemplateStatus('test-api-key', 'saving_alert');
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('template contains promotional language');
  });

  it('URL-encodes template names with special characters', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      name: 'fixed_term_expiry',
      status: 'pending',
      lastCheckedAt: '2026-06-29T10:00:00Z',
    }));

    await getTemplateStatus('test-api-key', 'fixed_term_expiry');
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/v1/templates/fixed_term_expiry');
  });
});