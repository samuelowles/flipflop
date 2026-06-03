import type { Bill } from '../types/bill';

interface MonthlyAverage {
  readonly avgKwh: number;
  readonly avgCostCents: number;
  readonly avgCPerKwh: number;
  readonly monthCount: number;
}

interface SeasonalBaseline {
  readonly summer: MonthlyAverage;
  readonly winter: MonthlyAverage;
}

interface Anomaly {
  readonly billId: string;
  readonly field: string;
  readonly value: number;
  readonly mean: number;
  readonly stdDev: number;
  readonly zScore: number;
}

interface YoYComparison {
  readonly currentPeriod: { readonly kwh: number; readonly costCents: number };
  readonly previousPeriod: { readonly kwh: number; readonly costCents: number };
  readonly kwhChangePct: number;
  readonly costChangePct: number;
}

interface BillRow {
  readonly id: string;
  readonly user_id: string;
  readonly usage_kwh: number | null;
  readonly total_cents: number | null;
  readonly c_per_kwh: number | null;
  readonly period_start: string | null;
}

function rowToBill(row: Record<string, unknown>): BillRow {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    usage_kwh: row.usage_kwh as number | null,
    total_cents: row.total_cents as number | null,
    c_per_kwh: row.c_per_kwh as number | null,
    period_start: row.period_start as string | null,
  };
}

function parseMonth(dateStr: string): number {
  // ISO 8601 date string -> month number (0=Jan, 11=Dec)
  return new Date(dateStr).getMonth();
}

function isSummer(month: number): boolean {
  // NZ seasons: summer = Dec(11), Jan(0), Feb(1)
  return month === 11 || month === 0 || month === 1;
}

function isWinter(month: number): boolean {
  // NZ seasons: winter = Jun(5), Jul(6), Aug(7)
  return month === 5 || month === 6 || month === 7;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: readonly number[], avg: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

async function getParsedBills(
  userId: string,
  db: D1Database
): Promise<readonly BillRow[]> {
  const stmt = db.prepare(
    `SELECT id, user_id, usage_kwh, total_cents, c_per_kwh, period_start
     FROM bills
     WHERE user_id = ?1
       AND status = 'parsed'
       AND usage_kwh IS NOT NULL
       AND total_cents IS NOT NULL
     ORDER BY period_start DESC`
  );
  const result = await stmt.bind(userId).all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToBill);
}

/**
 * Compute monthly averages for a user's parsed bills.
 * @param months - optional limit on most recent months (default: all)
 */
export async function computeMonthlyAverage(
  userId: string,
  db: D1Database,
  months?: number
): Promise<MonthlyAverage> {
  const allBills = await getParsedBills(userId, db);
  const bills = months ? allBills.slice(0, months) : allBills;

  const kwhValues: number[] = [];
  const costValues: number[] = [];
  const cPerKwhValues: number[] = [];

  for (const bill of bills) {
    if (bill.usage_kwh != null) kwhValues.push(bill.usage_kwh);
    if (bill.total_cents != null) costValues.push(bill.total_cents);
    if (bill.c_per_kwh != null) cPerKwhValues.push(bill.c_per_kwh);
  }

  return {
    avgKwh: Math.round(mean(kwhValues)),
    avgCostCents: Math.round(mean(costValues)),
    avgCPerKwh: cPerKwhValues.length > 0 ? Math.round(mean(cPerKwhValues) * 10) / 10 : 0,
    monthCount: bills.length,
  };
}

/**
 * Compute seasonal baselines: summer (Dec-Feb) and winter (Jun-Aug).
 */
export async function computeSeasonalBaseline(
  userId: string,
  db: D1Database
): Promise<SeasonalBaseline> {
  const bills = await getParsedBills(userId, db);

  const summerBills: BillRow[] = [];
  const winterBills: BillRow[] = [];

  for (const bill of bills) {
    if (!bill.period_start) continue;
    const month = parseMonth(bill.period_start);
    if (isSummer(month)) {
      summerBills.push(bill);
    } else if (isWinter(month)) {
      winterBills.push(bill);
    }
  }

  const summer = buildMonthlyAverage(summerBills);
  const winter = buildMonthlyAverage(winterBills);

  return { summer, winter };
}

function buildMonthlyAverage(bills: readonly BillRow[]): MonthlyAverage {
  const kwhValues: number[] = [];
  const costValues: number[] = [];
  const cPerKwhValues: number[] = [];

  for (const bill of bills) {
    if (bill.usage_kwh != null) kwhValues.push(bill.usage_kwh);
    if (bill.total_cents != null) costValues.push(bill.total_cents);
    if (bill.c_per_kwh != null) cPerKwhValues.push(bill.c_per_kwh);
  }

  return {
    avgKwh: Math.round(mean(kwhValues)),
    avgCostCents: Math.round(mean(costValues)),
    avgCPerKwh: cPerKwhValues.length > 0 ? Math.round(mean(cPerKwhValues) * 10) / 10 : 0,
    monthCount: bills.length,
  };
}

/**
 * Detect anomalous bills. Flags any bill where a field value deviates
 * by more than 2 standard deviations from the user's mean.
 */
export async function detectAnomalies(
  userId: string,
  _latestBill: Bill,
  db: D1Database
): Promise<readonly Anomaly[]> {
  const bills = await getParsedBills(userId, db);

  const usageValues: { billId: string; value: number }[] = [];
  const costValues: { billId: string; value: number }[] = [];

  for (const bill of bills) {
    if (bill.usage_kwh != null) {
      usageValues.push({ billId: bill.id, value: bill.usage_kwh });
    }
    if (bill.total_cents != null) {
      costValues.push({ billId: bill.id, value: bill.total_cents });
    }
  }

  const usageNums = usageValues.map(v => v.value);
  const costNums = costValues.map(v => v.value);

  const usageMean = mean(usageNums);
  const usageStdDev = stdDev(usageNums, usageMean);
  const costMean = mean(costNums);
  const costStdDev = stdDev(costNums, costMean);

  const anomalies: Anomaly[] = [];

  for (const { billId, value } of usageValues) {
    if (usageStdDev === 0) continue;
    const zScore = (value - usageMean) / usageStdDev;
    if (Math.abs(zScore) > 2) {
      anomalies.push({
        billId,
        field: 'usage_kwh',
        value,
        mean: usageMean,
        stdDev: usageStdDev,
        zScore: Math.round(zScore * 100) / 100,
      });
    }
  }

  for (const { billId, value } of costValues) {
    if (costStdDev === 0) continue;
    const zScore = (value - costMean) / costStdDev;
    if (Math.abs(zScore) > 2) {
      anomalies.push({
        billId,
        field: 'total_cents',
        value,
        mean: costMean,
        stdDev: costStdDev,
        zScore: Math.round(zScore * 100) / 100,
      });
    }
  }

  return anomalies;
}

/**
 * Compute year-over-year comparison: last 12 months vs prior 12 months.
 * Returns null if insufficient data for either period.
 */
export async function computeYearOverYear(
  userId: string,
  db: D1Database
): Promise<YoYComparison | null> {
  const bills = await getParsedBills(userId, db);
  if (bills.length === 0) return null;

  // Find the latest bill date
  const latestDate = bills.reduce((max, b) => {
    if (!b.period_start) return max;
    return b.period_start > max ? b.period_start : max;
  }, '');

  if (!latestDate) return null;

  const latestMs = new Date(latestDate).getTime();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const twoYearsMs = 2 * oneYearMs;

  const currentCutoff = new Date(latestMs - oneYearMs).toISOString();
  const previousCutoff = new Date(latestMs - twoYearsMs).toISOString();

  const currentBills: BillRow[] = [];
  const previousBills: BillRow[] = [];

  const currentCutoffMs = new Date(currentCutoff).getTime();
  const previousCutoffMs = new Date(previousCutoff).getTime();

  for (const bill of bills) {
    if (!bill.period_start) continue;
    const billMs = new Date(bill.period_start).getTime();
    if (Number.isNaN(billMs)) continue;
    if (billMs > currentCutoffMs) {
      currentBills.push(bill);
    } else if (billMs > previousCutoffMs) {
      previousBills.push(bill);
    }
  }

  if (currentBills.length === 0 || previousBills.length === 0) return null;

  const currentKwh = currentBills.reduce((sum, b) => sum + (b.usage_kwh ?? 0), 0);
  const currentCost = currentBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0);
  const previousKwh = previousBills.reduce((sum, b) => sum + (b.usage_kwh ?? 0), 0);
  const previousCost = previousBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0);

  const kwhChangePct = previousKwh > 0
    ? Math.round(((currentKwh - previousKwh) / previousKwh) * 1000) / 10
    : 0;
  const costChangePct = previousCost > 0
    ? Math.round(((currentCost - previousCost) / previousCost) * 1000) / 10
    : 0;

  return {
    currentPeriod: { kwh: currentKwh, costCents: currentCost },
    previousPeriod: { kwh: previousKwh, costCents: previousCost },
    kwhChangePct,
    costChangePct,
  };
}
