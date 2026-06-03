import { describe, it, expect } from 'vitest';
import {
  computeMonthlyAverage,
  computeSeasonalBaseline,
  detectAnomalies,
  computeYearOverYear,
} from './usageTracker';
import type { Bill } from '../types/bill';

function createMockDb(rows: readonly Record<string, unknown>[]): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({}),
      }),
    }),
  } as unknown as D1Database;
}

function makeBillRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'bill-1',
    user_id: overrides.user_id ?? 'user-1',
    usage_kwh: overrides.usage_kwh ?? 500,
    total_cents: overrides.total_cents ?? 12500,
    c_per_kwh: overrides.c_per_kwh ?? 25.0,
    period_start: overrides.period_start ?? '2026-04-01T00:00:00+12:00',
  };
}

function makeLatestBill(): Bill {
  return {
    id: 'bill-latest',
    userId: 'user-1',
    retailerId: 'contact',
    planName: 'Standard',
    meterType: 'standard',
    periodStart: '2026-05-01T00:00:00+12:00',
    periodEnd: '2026-05-31T00:00:00+12:00',
    days: 31,
    usageKwh: 600,
    totalCents: 15000,
    cPerKwh: 25.0,
    cPerDay: 90.0,
    fixedTermExpiry: null,
    breakFeeCents: null,
    status: 'parsed',
    confidence: 0.92,
    rawR2Key: 'bills/test.pdf',
    parsedJson: null,
    source: 'whatsapp',
    createdAt: '2026-05-01T00:00:00+12:00',
  };
}

describe('computeMonthlyAverage', () => {
  it('should compute averages from parsed bills', async () => {
    const rows = [
      makeBillRow({ id: 'b1', usage_kwh: 500, total_cents: 12500, c_per_kwh: 25.0 }),
      makeBillRow({ id: 'b2', usage_kwh: 600, total_cents: 15000, c_per_kwh: 25.0 }),
      makeBillRow({ id: 'b3', usage_kwh: 400, total_cents: 10000, c_per_kwh: 25.0 }),
    ];

    const db = createMockDb(rows);
    const result = await computeMonthlyAverage('user-1', db);

    expect(result.avgKwh).toBe(500);
    expect(result.avgCostCents).toBe(12500);
    expect(result.avgCPerKwh).toBe(25.0);
    expect(result.monthCount).toBe(3);
  });

  it('should limit results when months parameter is provided', async () => {
    const rows = [
      makeBillRow({ id: 'b1', usage_kwh: 600, total_cents: 18000 }),
      makeBillRow({ id: 'b2', usage_kwh: 500, total_cents: 15000 }),
      makeBillRow({ id: 'b3', usage_kwh: 300, total_cents: 9000 }),
    ];

    const db = createMockDb(rows);
    const result = await computeMonthlyAverage('user-1', db, 2);

    expect(result.monthCount).toBe(2);
    expect(result.avgKwh).toBe(550);
  });

  it('should handle empty results', async () => {
    const db = createMockDb([]);
    const result = await computeMonthlyAverage('user-1', db);

    expect(result.avgKwh).toBe(0);
    expect(result.avgCostCents).toBe(0);
    expect(result.monthCount).toBe(0);
  });
});

describe('computeSeasonalBaseline', () => {
  it('should split bills into summer and winter', async () => {
    const rows = [
      makeBillRow({ id: 's1', usage_kwh: 400, total_cents: 10000, period_start: '2025-12-15T00:00:00+13:00' }),
      makeBillRow({ id: 's2', usage_kwh: 350, total_cents: 8750, period_start: '2026-01-15T00:00:00+13:00' }),
      makeBillRow({ id: 'w1', usage_kwh: 700, total_cents: 17500, period_start: '2025-07-15T00:00:00+12:00' }),
      makeBillRow({ id: 'w2', usage_kwh: 750, total_cents: 18750, period_start: '2025-08-15T00:00:00+12:00' }),
    ];

    const db = createMockDb(rows);
    const result = await computeSeasonalBaseline('user-1', db);

    expect(result.summer.avgKwh).toBe(375);
    expect(result.summer.monthCount).toBe(2);
    expect(result.winter.avgKwh).toBe(725);
    expect(result.winter.monthCount).toBe(2);
  });

  it('should handle no seasonal data', async () => {
    const rows = [
      makeBillRow({ id: 'f1', usage_kwh: 500, total_cents: 12500, period_start: '2025-03-15T00:00:00+13:00' }),
      makeBillRow({ id: 'f2', usage_kwh: 480, total_cents: 12000, period_start: '2025-10-15T00:00:00+13:00' }),
    ];

    const db = createMockDb(rows);
    const result = await computeSeasonalBaseline('user-1', db);

    expect(result.summer.monthCount).toBe(0);
    expect(result.winter.monthCount).toBe(0);
  });
});

describe('detectAnomalies', () => {
  it('should detect bills with z-score > 2', async () => {
    // 5 normal bills ~500 kWh, one extreme spike at 1300 (z≈2.0)
    const rows = [
      makeBillRow({ id: 'b1', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b2', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b3', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b4', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b5', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b6', usage_kwh: 1300, total_cents: 32500 }),
    ];

    const db = createMockDb(rows);
    const latestBill = makeLatestBill();
    const anomalies = await detectAnomalies('user-1', latestBill, db);

    expect(anomalies.length).toBeGreaterThan(0);
    const usageAnomaly = anomalies.find(a => a.field === 'usage_kwh');
    expect(usageAnomaly).toBeDefined();
    if (usageAnomaly) {
      expect(usageAnomaly.billId).toBe('b6');
      expect(usageAnomaly.zScore).toBeGreaterThan(2);
    }
  });

  it('should return empty array when no anomalies exist', async () => {
    const rows = [
      makeBillRow({ id: 'b1', usage_kwh: 500, total_cents: 12500 }),
      makeBillRow({ id: 'b2', usage_kwh: 510, total_cents: 12750 }),
      makeBillRow({ id: 'b3', usage_kwh: 490, total_cents: 12250 }),
    ];

    const db = createMockDb(rows);
    const latestBill = makeLatestBill();
    const anomalies = await detectAnomalies('user-1', latestBill, db);

    expect(anomalies).toHaveLength(0);
  });

  it('should return empty array with insufficient data', async () => {
    const rows = [makeBillRow({ id: 'b1', usage_kwh: 500, total_cents: 12500 })];

    const db = createMockDb(rows);
    const latestBill = makeLatestBill();
    const anomalies = await detectAnomalies('user-1', latestBill, db);

    // StdDev is 0 with only 1 data point, so no anomalies
    expect(anomalies).toHaveLength(0);
  });
});

describe('computeYearOverYear', () => {
  it('should compare last 12 months vs prior 12 months', async () => {
    const rows = [
      // Current period (within last 12 months)
      makeBillRow({ id: 'c1', usage_kwh: 500, total_cents: 12500, period_start: '2026-03-01T00:00:00+13:00' }),
      makeBillRow({ id: 'c2', usage_kwh: 550, total_cents: 13750, period_start: '2026-01-01T00:00:00+13:00' }),
      makeBillRow({ id: 'c3', usage_kwh: 480, total_cents: 12000, period_start: '2025-11-01T00:00:00+13:00' }),
      // Previous period (12-24 months ago)
      makeBillRow({ id: 'p1', usage_kwh: 450, total_cents: 11000, period_start: '2025-03-01T00:00:00+13:00' }),
      makeBillRow({ id: 'p2', usage_kwh: 500, total_cents: 12000, period_start: '2025-01-01T00:00:00+13:00' }),
      makeBillRow({ id: 'p3', usage_kwh: 460, total_cents: 11200, period_start: '2024-11-01T00:00:00+13:00' }),
    ];

    const db = createMockDb(rows);
    const result = await computeYearOverYear('user-1', db);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.currentPeriod.kwh).toBeGreaterThan(0);
      expect(result.previousPeriod.kwh).toBeGreaterThan(0);
      // Current: 500+550+480=1530, Previous: 450+500+460=1410, change: +120/1410 = 8.5%
      expect(result.kwhChangePct).toBeCloseTo(8.5, 0);
    }
  });

  it('should return null with insufficient data', async () => {
    const rows = [
      makeBillRow({ id: 'c1', usage_kwh: 500, total_cents: 12500, period_start: '2026-03-01T00:00:00+13:00' }),
    ];

    const db = createMockDb(rows);
    const result = await computeYearOverYear('user-1', db);

    expect(result).toBeNull();
  });
});
