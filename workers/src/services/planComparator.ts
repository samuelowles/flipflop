/**
 * Plan comparison service — runs comparison against Python /compare endpoint.
 *
 * Triggered by Queue (flip-compare-queue) after a bill is successfully parsed.
 * Stores results in D1 plan_comparisons table and enqueues notifications.
 */

import { getBillsByUserId } from '../models/bills';
import { getPlansByRegion, getPlansByRetailer } from '../models/plans';
import { createComparison } from '../models/comparisons';

interface UsageProfile {
  readonly avgDailyKwh: number;
  readonly meterType: string;
  readonly seasonalWeights: { readonly summer: number; readonly winter: number };
}

interface BillSummary {
  readonly id: string;
  readonly usageKwh: number;
  readonly totalCents: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: number;
  readonly breakFeeCents?: number;
}

interface ComparisonRequest {
  readonly usageProfile: UsageProfile;
  readonly currentPlan: Record<string, unknown>;
  readonly availablePlans: readonly Record<string, unknown>[];
  readonly billHistory: readonly BillSummary[];
}

interface ComparisonResultItem {
  readonly plan_name: string;
  readonly retailer_name: string;
  readonly retailer_id: string;
  readonly projected_cost_cents: number;
  readonly current_cost_cents: number;
  readonly saving_cents: number; // positive = saving (Python convention)
  readonly confidence: number;
  readonly stay_where_you_are: boolean;
}

interface CompareEnv {
  readonly DB: D1Database;
  readonly NOTIFY_QUEUE: Queue<{ userId: string; comparisonId: string }>;
  readonly SENT_API_KEY: string;
  readonly PYTHON_SERVICE_URL?: string;
  readonly PYTHON_SERVICE_AUTH_TOKEN?: string;
}

const SAVING_THRESHOLD_CENTS = 5000; // $50 NZD minimum saving to notify

function billToSummary(bill: { id: string; usageKwh: number | null; totalCents: number | null; periodStart: string | null; periodEnd: string | null; days: number | null; breakFeeCents: number | null }): BillSummary | null {
  if (bill.usageKwh == null || bill.totalCents == null || !bill.periodStart || !bill.periodEnd || bill.days == null) return null;
  return {
    id: bill.id,
    usageKwh: bill.usageKwh,
    totalCents: bill.totalCents,
    periodStart: bill.periodStart,
    periodEnd: bill.periodEnd,
    days: bill.days,
    breakFeeCents: bill.breakFeeCents ?? undefined,
  };
}

function computeAvgDailyKwh(bills: readonly BillSummary[]): number {
  if (bills.length === 0) return 0;
  const totalKwh = bills.reduce((sum, b) => sum + b.usageKwh, 0);
  const totalDays = bills.reduce((sum, b) => sum + b.days, 0);
  return totalDays > 0 ? Math.round((totalKwh / totalDays) * 100) / 100 : 0;
}

function getSeason(m: number): 'summer' | 'winter' | 'shoulder' {
  if (m === 11 || m === 0 || m === 1) return 'summer';
  if (m === 5 || m === 6 || m === 7) return 'winter';
  return 'shoulder';
}

function computeSeasonalWeights(bills: readonly BillSummary[]): { summer: number; winter: number } {
  const seasonal = { summer: 0, winter: 0 };
  const counts = { summer: 0, winter: 0 };

  for (const bill of bills) {
    const month = new Date(bill.periodStart).getMonth();
    const season = getSeason(month);
    if (season === 'summer') {
      seasonal.summer += bill.usageKwh;
      counts.summer++;
    } else if (season === 'winter') {
      seasonal.winter += bill.usageKwh;
      counts.winter++;
    }
  }

  return {
    summer: counts.summer > 0 ? seasonal.summer / counts.summer : 0,
    winter: counts.winter > 0 ? seasonal.winter / counts.winter : 0,
  };
}

/**
 * Run a full plan comparison for a user after a new bill is parsed.
 * Called from the compare queue consumer.
 */
export async function runComparison(
  userId: string,
  env: CompareEnv
): Promise<string | null> {
  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';

  // 1. Fetch user's bill history (parsed bills only)
  const allBills = await getBillsByUserId(env.DB, userId);
  const parsedBills = allBills.filter(b => b.status === 'parsed');

  if (parsedBills.length === 0) {
    console.log(JSON.stringify({
      type: 'compare_skip',
      userId,
      reason: 'no parsed bills',
      timestamp: new Date().toISOString(),
    }));
    return null;
  }

  // 2. Build bill summaries for Python
  const billSummaries = parsedBills.map(billToSummary).filter(Boolean) as BillSummary[];
  if (billSummaries.length === 0) {
    console.log(JSON.stringify({
      type: 'compare_skip',
      userId,
      reason: 'no valid bill summaries',
      timestamp: new Date().toISOString(),
    }));
    return null;
  }

  // 3. Build usage profile
  const avgDailyKwh = computeAvgDailyKwh(billSummaries);
  const seasonalWeights = computeSeasonalWeights(billSummaries);
  const meterType = parsedBills[0]?.meterType ?? 'standard';

  const usageProfile: UsageProfile = {
    avgDailyKwh,
    meterType,
    seasonalWeights,
  };

  // 4. Build current plan from most recent bill
  const latestBill = parsedBills[0]!;
  const currentPlan: Record<string, unknown> = {
    plan_name: latestBill.planName ?? 'Unknown',
    retailer_id: latestBill.retailerId,
    c_per_kwh: latestBill.cPerKwh,
    c_per_day: latestBill.cPerDay,
    meter_type: latestBill.meterType,
    break_fee_cents: latestBill.breakFeeCents,
    fixed_term_expiry: latestBill.fixedTermExpiry,
  };

  // 5. Derive region from bill data — look up the user's retailer to find region
  let region: string | null = 'National';
  if (latestBill.retailerId) {
    const retailerPlans = await getPlansByRetailer(env.DB, latestBill.retailerId);
    if (retailerPlans.length > 0) {
      const matchingPlan = latestBill.planName
        ? retailerPlans.find(p => p.name === latestBill.planName)
        : undefined;
      region = matchingPlan?.region ?? retailerPlans[0]!.region ?? 'National';
    }
  }

  // Fetch available plans for comparison
  const availablePlans = await getPlansByRegion(env.DB, region);

  // Populate currentPlan id from available plans so Python can detect stay_where_you_are
  if (latestBill.retailerId && latestBill.planName) {
    const matchedCurrentPlan = availablePlans.find(
      p => p.retailerId === latestBill.retailerId && p.name === latestBill.planName
    );
    if (matchedCurrentPlan) {
      currentPlan.id = matchedCurrentPlan.id;
    }
  }

  const planDicts = availablePlans.map(p => ({
    id: p.id,
    retailer_id: p.retailerId,
    name: p.name,
    region: p.region,
    c_per_kwh: p.cPerKwh,
    c_per_day: p.cPerDay,
    tier_thresholds_json: p.tierThresholdsJson,
    prompt_payment_discount: p.promptPaymentDiscount,
    conditions_json: p.conditionsJson,
    low_user_eligible: p.lowUserEligible,
  }));

  if (planDicts.length === 0) {
    console.log(JSON.stringify({
      type: 'compare_skip',
      userId,
      reason: 'no plans available',
      timestamp: new Date().toISOString(),
    }));
    return null;
  }

  // 6. POST to Python /compare
  const request: ComparisonRequest = {
    usageProfile,
    currentPlan,
    availablePlans: planDicts,
    billHistory: billSummaries,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.PYTHON_SERVICE_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${env.PYTHON_SERVICE_AUTH_TOKEN}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${pythonUrl}/compare`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`Python compare service returned ${response.status}`);
  }

  const results = await response.json() as { comparisons: ComparisonResultItem[] };

  // Log warning if savings don't cover exit fees
  if (latestBill.breakFeeCents != null) {
    for (const item of results.comparisons) {
      if (item.saving_cents > 0 && item.saving_cents < latestBill.breakFeeCents) {
        console.log(JSON.stringify({
          type: 'compare_break_fee_warning',
          planName: item.plan_name,
          savingCents: item.saving_cents,
          breakFeeCents: latestBill.breakFeeCents,
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  // 7. Store results in D1
  const comparisonIds: string[] = [];
  for (const item of results.comparisons) {
    // Find matching plan ID from availablePlans
    const matchedPlan = availablePlans.find(
      p => p.retailerId === item.retailer_id && p.name === item.plan_name
    );

    if (!matchedPlan) continue;

    const comparison = await createComparison(env.DB, {
      userId,
      planId: matchedPlan.id,
      billIdsJson: JSON.stringify(billSummaries.map(b => b.id)),
      projectedCostCents: item.projected_cost_cents,
      currentCostCents: item.current_cost_cents,
      savingCents: item.saving_cents,
      confidence: item.confidence,
    });
    comparisonIds.push(comparison.id);

    // 8. Enqueue notification if saving exceeds threshold
    if (item.saving_cents > SAVING_THRESHOLD_CENTS) {
      await env.NOTIFY_QUEUE.send({ userId, comparisonId: comparison.id });
      console.log(JSON.stringify({
        type: 'compare_enqueued_notification',
        userId,
        comparisonId: comparison.id,
        savingCents: item.saving_cents,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  console.log(JSON.stringify({
    type: 'compare_complete',
    userId,
    plansCompared: results.comparisons.length,
    storedResults: comparisonIds.length,
    timestamp: new Date().toISOString(),
  }));

  return comparisonIds.length > 0 ? comparisonIds[0]! : null;
}
