import { describe, it, expect, vi, beforeEach } from 'vitest';
import { comparePlans } from './planComparator';
import type { ComparisonInput, ComparisonResultItem } from '../types/comparison';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const env = {
  PYTHON_SERVICE_URL: 'http://python.test',
  PYTHON_SERVICE_AUTH_TOKEN: 'secret-token',
};

const baseInput: ComparisonInput = {
  usageProfile: {
    avgDailyKwh: 22.5,
    meterType: 'standard',
    seasonalWeights: { summer: 20, winter: 25 },
  },
  currentPlan: {
    id: 'plan-current-1',
    retailer_id: 'ret-a',
    plan_name: 'Current Plan',
    c_per_kwh: 28.5,
    c_per_day: 2.5,
    break_fee_cents: 15000,
    fixed_term_expiry: '2027-01-01T00:00:00Z',
  },
  availablePlans: [
    {
      id: 'plan-current-1',
      retailer_id: 'ret-a',
      name: 'Current Plan',
      c_per_kwh: 28.5,
      c_per_day: 2.5,
      low_user_eligible: false,
    },
    {
      id: 'plan-cheap-1',
      retailer_id: 'ret-b',
      name: 'Cheaper Plan',
      c_per_kwh: 25.0,
      c_per_day: 2.0,
      low_user_eligible: false,
    },
  ],
  billHistory: [
    {
      id: 'bill-1',
      usageKwh: 675,
      totalCents: 24000,
      periodStart: '2026-05-01T00:00:00Z',
      periodEnd: '2026-06-01T00:00:00Z',
      days: 31,
    },
  ],
};

// Mirrors the bare list shape that python/comparator/plan_comparator.py returns
// (server.py does jsonify(results), NOT {comparisons: [...]}).
const pythonResult: ComparisonResultItem[] = [
  {
    plan_id: 'plan-cheap-1',
    plan_name: 'Cheaper Plan',
    retailer_id: 'ret-b',
    projected_cost_cents: 280000,
    current_cost_cents: 300000,
    saving_cents: 20000,
    confidence: 0.85,
    stay_where_you_are: false,
    comparison_details: '{"avg_daily_kwh": 22.5}',
  },
  {
    plan_id: 'plan-current-1',
    plan_name: 'Current Plan',
    retailer_id: 'ret-a',
    projected_cost_cents: 300000,
    current_cost_cents: 300000,
    saving_cents: 0,
    confidence: 0.85,
    stay_where_you_are: true,
    comparison_details: '{"avg_daily_kwh": 22.5}',
  },
];

function mockOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('comparePlans — Worker/Python contract (#123)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('POSTs to ${PYTHON_SERVICE_URL}/compare and returns the typed ranked list', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(pythonResult));

    const result = await comparePlans(baseInput, env);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://python.test/compare');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
      },
    });

    // Body is the comparison input, snake_cased for Python
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.usage_profile.avg_daily_kwh).toBe(22.5);
    expect(body.available_plans[1].retailer_id).toBe('ret-b');

    // Result is the bare ranked list, top result is the cheapest non-current plan
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]!.plan_id).toBe('plan-cheap-1');
    expect(result[0]!.saving_cents).toBe(20000);
    expect(result[0]!.stay_where_you_are).toBe(false);
    expect(result[1]!.stay_where_you_are).toBe(true);
  });

  it('validates input at the boundary and throws on empty availablePlans', async () => {
    await expect(
      comparePlans({ ...baseInput, availablePlans: [] }, env)
    ).rejects.toThrow(/availablePlans must be a non-empty array/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when Python returns a non-OK status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(comparePlans(baseInput, env)).rejects.toThrow(
      /Python compare service returned 500/
    );
  });
});
