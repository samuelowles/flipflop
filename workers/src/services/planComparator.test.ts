import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies — runComparison touches bills, plans (retailer lookup for
// region derivation), the canonical-plan aggregator, comparisons persistence,
// and the Python boundary via globalThis.fetch.
vi.mock('../models/bills', () => ({
  getBillsByUserId: vi.fn(),
}));

vi.mock('../models/plans', () => ({
  getPlansByRetailer: vi.fn(),
}));

vi.mock('./planAggregator', () => ({
  getCanonicalPlans: vi.fn(),
}));

vi.mock('../models/comparisons', () => ({
  createComparison: vi.fn(),
}));

import { runComparison } from './planComparator';
import { getBillsByUserId } from '../models/bills';
import { getPlansByRetailer } from '../models/plans';
import { getCanonicalPlans } from './planAggregator';
import { createComparison } from '../models/comparisons';
import type { Bill } from '../types/bill';
import type { Plan } from '../types/plan';
import type { ComparisonResultItem, PlanComparison } from '../types/comparison';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const notifySend = vi.fn();
const env = {
  DB: {} as D1Database,
  NOTIFY_QUEUE: { send: notifySend, sendBatch: vi.fn() } as unknown as Queue<{
    userId: string;
    comparisonId: string;
  }>,
  SENT_API_KEY: 'sent-key',
  PYTHON_SERVICE_URL: 'http://python.test',
};

function makeParsedBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 'bill-1',
    userId: 'user-1',
    retailerId: 'ret-a',
    planName: 'Current Plan',
    meterType: 'standard',
    periodStart: '2026-05-01T00:00:00Z',
    periodEnd: '2026-06-01T00:00:00Z',
    days: 31,
    usageKwh: 675,
    totalCents: 24000,
    cPerKwh: 28.5,
    cPerDay: 2.5,
    fixedTermExpiry: null,
    breakFeeCents: null,
    status: 'parsed',
    confidence: 0.9,
    rawR2Key: 'bills/u/b.pdf',
    parsedJson: null,
    source: 'gmail',
    sourceMessageId: null,
    errorCode: null,
    parsedAt: '2026-06-02T00:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const canonicalPlans: Plan[] = [
  {
    id: 'plan-current-1',
    retailerId: 'ret-a',
    name: 'Current Plan',
    region: 'Auckland',
    cPerKwh: 28.5,
    cPerDay: 2.5,
    tierThresholdsJson: null,
    promptPaymentDiscount: null,
    conditionsJson: null,
    lowUserEligible: false,
    source: 'manual',
    eiep14aId: null,
    effectiveFrom: null,
    effectiveTo: null,
    provenance: 'manual',
    sourceUrl: null,
    ingestedAt: '2026-01-01T00:00:00Z',
    contentHash: null,
    isCurrent: true,
  },
  {
    id: 'plan-cheap-1',
    retailerId: 'ret-b',
    name: 'Cheaper Plan',
    region: 'Auckland',
    cPerKwh: 25.0,
    cPerDay: 2.0,
    tierThresholdsJson: null,
    promptPaymentDiscount: null,
    conditionsJson: null,
    lowUserEligible: false,
    source: 'powerswitch',
    eiep14aId: null,
    effectiveFrom: null,
    effectiveTo: null,
    provenance: 'powerswitch',
    sourceUrl: null,
    ingestedAt: '2026-01-01T00:00:00Z',
    contentHash: null,
    isCurrent: true,
  },
];

const pythonResult: ComparisonResultItem[] = [
  {
    plan_id: 'plan-cheap-1',
    plan_name: 'Cheaper Plan',
    retailer_id: 'ret-b',
    projected_cost_cents: 280000,
    current_cost_cents: 300000,
    saving_cents: 20000, // $200 NZD — well above the $50 notify threshold
    confidence: 0.85,
    stay_where_you_are: false,
    comparison_details: '{}',
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
    comparison_details: '{}',
  },
];

function mockComparison(id: string): PlanComparison {
  return {
    id,
    userId: 'user-1',
    planId: 'plan-cheap-1',
    billIdsJson: '[]',
    projectedCostCents: 280000,
    currentCostCents: 300000,
    savingCents: 20000,
    confidence: 0.85,
    comparedAt: '2026-06-02T00:00:00Z',
  };
}

describe('runComparison — happy path (#70)', () => {
  beforeEach(() => {
    vi.mocked(getBillsByUserId).mockReset();
    vi.mocked(getPlansByRetailer).mockReset();
    vi.mocked(getCanonicalPlans).mockReset();
    vi.mocked(createComparison).mockReset();
    mockFetch.mockReset();
    notifySend.mockReset();
  });

  it('fetches the bill, derives region via retailer, calls the aggregator, POSTs to Python, persists, and enqueues notify', async () => {
    // Bill history: one parsed bill, region derived from the retailer's plans.
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([makeParsedBill()]);
    // Region derivation: retailer's plans include the matching current plan.
    vi.mocked(getPlansByRetailer).mockResolvedValueOnce(canonicalPlans);
    // Canonical aggregator returns de-duplicated plans.
    vi.mocked(getCanonicalPlans).mockResolvedValueOnce(canonicalPlans);
    // Persistence returns a comparison row per saved result.
    vi.mocked(createComparison)
      .mockResolvedValueOnce(mockComparison('cmp-1'))
      .mockResolvedValueOnce(mockComparison('cmp-2'));
    // Python boundary returns the bare ranked list.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => pythonResult,
    } as unknown as Response);

    const result = await runComparison('user-1', env);

    // Returns the first comparison id (cheapest non-current plan saved).
    expect(result).toBe('cmp-1');

    // 1. Bill fetched.
    expect(getBillsByUserId).toHaveBeenCalledWith(env.DB, 'user-1');

    // 2. Region derived from the retailer's plans (bill-derived, not users.region).
    expect(getPlansByRetailer).toHaveBeenCalledWith(env.DB, 'ret-a');

    // 3. Canonical aggregator called with the derived region (not getPlansByRegion).
    expect(getCanonicalPlans).toHaveBeenCalledWith(
      env.DB,
      'Auckland',
      expect.objectContaining({ kwhPerMonth: expect.any(Number) })
    );

    // 4. Python called once.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://python.test/compare');
    const body = JSON.parse((init as RequestInit).body as string);
    // availablePlans came from the aggregator, not raw getPlansByRegion.
    expect(body.availablePlans).toHaveLength(2);
    expect(body.availablePlans[0].retailer_id).toBe('ret-a');

    // 5. Persisted one comparison per result that matched an available plan.
    expect(createComparison).toHaveBeenCalledTimes(2);

    // 6. Notify enqueued only for the plan that beat the $50 saving threshold.
    expect(notifySend).toHaveBeenCalledTimes(1);
    expect(notifySend).toHaveBeenCalledWith({ userId: 'user-1', comparisonId: 'cmp-1' });
  });

  it('skips and returns null when the user has no parsed bills', async () => {
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([
      makeParsedBill({ status: 'pending_parse' }),
    ]);

    const result = await runComparison('user-1', env);

    expect(result).toBeNull();
    expect(getCanonicalPlans).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
