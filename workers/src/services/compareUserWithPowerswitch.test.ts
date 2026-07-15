import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies — the comparison path touches bills, comparisons
// persistence, the #221 KV cache reader, and the Python boundary via fetch.
vi.mock('../models/bills', () => ({
  getBillsByUserId: vi.fn(),
}));

vi.mock('../models/comparisons', () => ({
  createComparison: vi.fn(),
}));

// Mock the KV cache reader so no live Powerswitch / KV dependency is needed.
vi.mock('./powerswitchReplay', () => ({
  readCachedResults: vi.fn(),
}));

import { compareUserWithPowerswitch } from './compareUserWithPowerswitch';
import { getBillsByUserId } from '../models/bills';
import { createComparison } from '../models/comparisons';
import { readCachedResults } from './powerswitchReplay';
import { parseRscResults } from './powerswitchRscParser';
import { rsc_results_flight } from './powerswitchFixtures';
import type { Bill } from '../types/bill';
import type { ComparisonResultItem, PlanComparison } from '../types/comparison';
import type { ParsedResults } from './powerswitchRscParser';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

/** Fake D1 that records INSERTs (for provenance assertion) and no-ops otherwise. */
function fakeDb() {
  const stmts: string[] = [];
  const db = {
    prepare: (sql: string) => {
      const bind = (..._args: unknown[]) => ({
        run: async () => {
          stmts.push(sql);
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      });
      return { bind, run: async () => { stmts.push(sql); return { meta: { changes: 0 } }; } };
    },
  } as unknown as D1Database;
  return { db, stmts };
}

function makeParsedBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 'bill-1',
    userId: 'user-1',
    retailerId: 'mercury',
    planName: 'Open Variable',
    meterType: 'standard',
    periodStart: '2026-05-01T00:00:00Z',
    periodEnd: '2026-06-01T00:00:00Z',
    days: 30,
    usageKwh: 600,
    totalCents: 24000,
    cPerKwh: 29.1,
    cPerDay: 2.30,
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

/** The fixture parsed-results payload (3 plans: single-rate, TOU, % discount). */
const fixtureResults = (): ParsedResults => {
  const parsed = parseRscResults(rsc_results_flight);
  if (parsed.status !== 'ok') throw new Error('fixture parse failed');
  return parsed.results;
};

function mockOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Python comparator result: Open Variable is cheapest, a switch verdict. */
function pythonSwitchResult(): ComparisonResultItem[] {
  return [
    {
      plan_id: 'plan_mercury_open_var',
      plan_name: 'Open Variable',
      retailer_id: 'mercury',
      projected_cost_cents: 240000,
      current_cost_cents: 260000,
      saving_cents: 20000,
      confidence: 0.85,
      stay_where_you_are: false,
      comparison_details: '{"avg_daily_kwh":20}',
      recommendation: 'switch',
      reason: null,
    },
    {
      plan_id: 'plan_contact_good_nights',
      plan_name: 'Good Nights',
      retailer_id: 'contact',
      projected_cost_cents: 0,
      current_cost_cents: 260000,
      saving_cents: 0,
      confidence: 0.85,
      stay_where_you_are: false,
      comparison_details: '{}',
      unsupported: true,
      unsupported_reason: 'time-of-use plan: usage windows not available for pricing',
      recommendation: 'switch',
      reason: null,
    },
  ];
}

describe('compareUserWithPowerswitch — E2E (#222)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns no_cache when no cached Powerswitch results exist', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(null);
    const { db } = fakeDb();

    const out = await compareUserWithPowerswitch('user-1', {
      DB: db,
      KV: {} as KVNamespace,
      PYTHON_SERVICE_URL: 'http://python.test',
    });

    expect(out.status).toBe('no_cache');
    expect(createComparison).not.toHaveBeenCalled();
  });

  it('returns no_plans when the cache has plans but none are mappable', async () => {
    // A plan set with only a % tariff (no rate, no daily charge) → unpriceable.
    vi.mocked(readCachedResults).mockResolvedValueOnce({
      usage: { annualKwh: 7800, monthlyKwh: Array(12).fill(650) },
      plans: [
        {
          id: 'p', name: 'P', retailerId: 'r', energyType: 'electricity',
          fixedTerm: false, priceChangeDue: null,
          tariffs: [
            { code: 'TD3', name: 'x', value: -10, valueArray: Array(12).fill(-10),
              displayType: 'percentage', registerContentCode: 'FREE',
              description: '', pricesLastChanged: null },
          ],
        },
      ],
    });
    const { db } = fakeDb();

    const out = await compareUserWithPowerswitch('user-1', {
      DB: db, KV: {} as KVNamespace, PYTHON_SERVICE_URL: 'http://python.test',
    });

    expect(out.status).toBe('no_plans');
  });

  it('runs a full comparison: fixture cache → comparator → plan_comparisons row', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(fixtureResults());
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([makeParsedBill()]);
    mockFetch.mockResolvedValueOnce(mockOk(pythonSwitchResult()));
    vi.mocked(createComparison).mockResolvedValueOnce({
      id: 'cmp-1', userId: 'user-1', planId: 'plan_mercury_open_var',
      billIdsJson: '["bill-1"]', projectedCostCents: 240000,
      currentCostCents: 260000, savingCents: 20000, confidence: 0.85,
      comparedAt: '2026-07-16T00:00:00Z', recommendation: 'switch', reason: null,
    } as PlanComparison);
    const { db, stmts } = fakeDb();

    const out = await compareUserWithPowerswitch('user-1', {
      DB: db, KV: {} as KVNamespace, PYTHON_SERVICE_URL: 'http://python.test',
    });

    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.recommendation).toBe('switch');
    expect(out.comparisonId).toBe('cmp-1');

    // createComparison received the verdict + the real bill id.
    expect(createComparison).toHaveBeenCalledTimes(1);
    const input = vi.mocked(createComparison).mock.calls[0]![1];
    expect(input.recommendation).toBe('switch');
    expect(input.billId).toBe('bill-1');
    expect(input.recommendedPlanId).toBe('plan_mercury_open_var');
    expect(input.billIdsJson).toBe('["bill-1"]');

    // A plan_data_provenance audit row was written (source='powerswitch_user').
    const provenanceInsert = stmts.find((s) => s.includes('plan_data_provenance'));
    expect(provenanceInsert).toBeDefined();

    // The Python comparator was POSTed the mapped plans (snake_cased).
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.availablePlans).toHaveLength(3);
    expect(body.availablePlans[0].retailer_id).toBe('mercury');
    // Usage came from the real bill (600 kWh / 30 days = 20/day).
    expect(body.usageProfile.avgDailyKwh).toBe(20);
  });

  it('carries caveats into the recommendation reason', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(fixtureResults());
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([makeParsedBill()]);
    // stay_put verdict from Python.
    mockFetch.mockResolvedValueOnce(mockOk([
      {
        plan_id: 'plan_mercury_open_var', plan_name: 'Open Variable',
        retailer_id: 'mercury', projected_cost_cents: 260000,
        current_cost_cents: 260000, saving_cents: 0, confidence: 0.85,
        stay_where_you_are: false, comparison_details: '{}',
        recommendation: 'stay_put', reason: 'no_savings',
      },
    ]));
    vi.mocked(createComparison).mockResolvedValueOnce({} as PlanComparison);
    const { db } = fakeDb();

    const out = await compareUserWithPowerswitch('user-1', {
      DB: db, KV: {} as KVNamespace, PYTHON_SERVICE_URL: 'http://python.test',
    });
    expect(out.status).toBe('ok');

    const input = vi.mocked(createComparison).mock.calls[0]![1];
    // The reason carries Python's no_savings + the TOU/modelled caveats.
    expect(input.reason).toContain('no_savings');
    expect(input.reason).toContain('TOU');
    expect(input.reason).toContain('modelled');
  });

  it('falls back to the Powerswitch usage estimate when no bill exists', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(fixtureResults());
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([]); // no bills
    mockFetch.mockResolvedValueOnce(mockOk(pythonSwitchResult()));
    vi.mocked(createComparison).mockResolvedValueOnce({} as PlanComparison);
    const { db } = fakeDb();

    const out = await compareUserWithPowerswitch('user-1', {
      DB: db, KV: {} as KVNamespace, PYTHON_SERVICE_URL: 'http://python.test',
    });
    expect(out.status).toBe('ok');

    // avgDailyKwh = annualKwh (7840) / 365 ≈ 21.48.
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.usageProfile.avgDailyKwh).toBeCloseTo(7840 / 365, 1);
    // billId is null (no bill), billIdsJson is null.
    const cmpInput = vi.mocked(createComparison).mock.calls[0]![1];
    expect(cmpInput.billId).toBeNull();
  });

  it('enqueues a notification on a switch verdict above the threshold', async () => {
    vi.mocked(readCachedResults).mockResolvedValueOnce(fixtureResults());
    vi.mocked(getBillsByUserId).mockResolvedValueOnce([makeParsedBill()]);
    mockFetch.mockResolvedValueOnce(mockOk(pythonSwitchResult())); // 20000 cents > 5000
    vi.mocked(createComparison).mockResolvedValueOnce({ id: 'cmp-1' } as unknown as PlanComparison);
    const notifySend = vi.fn();
    const { db } = fakeDb();

    await compareUserWithPowerswitch('user-1', {
      DB: db, KV: {} as KVNamespace, PYTHON_SERVICE_URL: 'http://python.test',
      NOTIFY_QUEUE: { send: notifySend, sendBatch: vi.fn() } as unknown as Queue<never>,
    });

    expect(notifySend).toHaveBeenCalledTimes(1);
    const payload = notifySend.mock.calls[0]![0] as { userId: string; recommendation: string };
    expect(payload.userId).toBe('user-1');
    expect(payload.recommendation).toBe('switch');
  });
});
