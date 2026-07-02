/**
 * Plan comparison service — runs comparison against Python /compare endpoint.
 *
 * Triggered by Queue (flip-compare-queue) after a bill is successfully parsed.
 * Stores results in D1 plan_comparisons table and enqueues notifications.
 */

import { getBillsByUserId } from '../models/bills';
import { getPlansByRetailer } from '../models/plans';
import { getCanonicalPlans } from './planAggregator';
import { createComparison } from '../models/comparisons';
import type {
  ComparisonBillSummary,
  ComparisonCurrentPlan,
  ComparisonInput,
  ComparisonResult,
  ComparisonUsageProfile,
} from '../types/comparison';

interface CompareEnv {
  readonly DB: D1Database;
  readonly NOTIFY_QUEUE: Queue<{ userId: string; comparisonId: string }>;
  readonly SENT_API_KEY: string;
  readonly PYTHON_SERVICE_URL?: string;
  readonly PYTHON_SERVICE_AUTH_TOKEN?: string;
}

// Minimal runtime validation — no zod dependency (Issue #123 boundary check).
function assertComparisonInput(input: ComparisonInput): void {
  const { usageProfile, currentPlan, availablePlans, billHistory } = input;
  if (typeof usageProfile?.avgDailyKwh !== 'number' || usageProfile.avgDailyKwh < 0) {
    throw new Error('Invalid comparison input: usageProfile.avgDailyKwh must be a non-negative number');
  }
  if (typeof usageProfile?.meterType !== 'string') {
    throw new Error('Invalid comparison input: usageProfile.meterType must be a string');
  }
  if (!currentPlan || typeof currentPlan !== 'object') {
    throw new Error('Invalid comparison input: currentPlan is required');
  }
  if (!Array.isArray(availablePlans) || availablePlans.length === 0) {
    throw new Error('Invalid comparison input: availablePlans must be a non-empty array');
  }
  if (!Array.isArray(billHistory)) {
    throw new Error('Invalid comparison input: billHistory must be an array');
  }
}

/**
 * Call the Python comparator service and return the typed result.
 *
 * This is the narrow Worker/Python boundary primitive: it validates the
 * input, POSTs to ${PYTHON_SERVICE_URL}/compare, and returns the ranked
 * comparison list. No persistence, no notifications — orchestration lives
 * in runComparison.
 *
 * Python owns all plan-cost math (deterministic); TypeScript holds schema only.
 */
export async function comparePlans(
  input: ComparisonInput,
  env: { readonly PYTHON_SERVICE_URL?: string; readonly PYTHON_SERVICE_AUTH_TOKEN?: string }
): Promise<ComparisonResult> {
  assertComparisonInput(input);

  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.PYTHON_SERVICE_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${env.PYTHON_SERVICE_AUTH_TOKEN}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${pythonUrl}/compare`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`Python compare service returned ${response.status}`);
  }

  // Python server returns the bare ranked list (jsonify(results)).
  return (await response.json()) as ComparisonResult;
}

const SAVING_THRESHOLD_CENTS = 5000; // $50 NZD minimum saving to notify

function billToSummary(bill: { id: string; usageKwh: number | null; totalCents: number | null; periodStart: string | null; periodEnd: string | null; days: number | null; breakFeeCents: number | null }): ComparisonBillSummary | null {
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

function computeAvgDailyKwh(bills: readonly ComparisonBillSummary[]): number {
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

function computeSeasonalWeights(bills: readonly ComparisonBillSummary[]): { summer: number; winter: number } {
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
  const billSummaries = parsedBills.map(billToSummary).filter(Boolean) as ComparisonBillSummary[];
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

  const usageProfile: ComparisonUsageProfile = {
    avgDailyKwh,
    meterType,
    seasonalWeights,
  };

  // 4. Build current plan from most recent bill
  const latestBill = parsedBills[0]!;
  let currentPlan: ComparisonCurrentPlan = {
    plan_name: latestBill.planName ?? 'Unknown',
    retailer_id: latestBill.retailerId ?? '',
    c_per_kwh: latestBill.cPerKwh ?? undefined,
    c_per_day: latestBill.cPerDay ?? undefined,
    break_fee_cents: latestBill.breakFeeCents ?? undefined,
    fixed_term_expiry: latestBill.fixedTermExpiry ?? undefined,
  };

  // 5. Derive region from bill data — no users.region column exists in the
  // schema (#73 owns migration 0014; a users.region column would collide).
  // Region is derived from the user's latest bill's retailer/network, falling
  // back to 'National'. The re-compare path (#75) may revisit region separately.
  let region: string = 'National';
  if (latestBill.retailerId) {
    const retailerPlans = await getPlansByRetailer(env.DB, latestBill.retailerId);
    if (retailerPlans.length > 0) {
      const matchingPlan = latestBill.planName
        ? retailerPlans.find(p => p.name === latestBill.planName)
        : undefined;
      region = matchingPlan?.region ?? retailerPlans[0]!.region ?? 'National';
    }
  }

  // Fetch available plans for comparison via the canonical-plan aggregator
  // (Issue #70): de-duplicates across manual/eiep14a/powerswitch sources by
  // precedence (manual > eiep14a > powerswitch) and drops incomplete rows.
  const availablePlans = await getCanonicalPlans(env.DB, region, { kwhPerMonth: avgDailyKwh * 30 });

  // Populate currentPlan id from available plans so Python can detect stay_where_you_are
  if (latestBill.retailerId && latestBill.planName) {
    const matchedCurrentPlan = availablePlans.find(
      p => p.retailerId === latestBill.retailerId && p.name === latestBill.planName
    );
    if (matchedCurrentPlan) {
      currentPlan = { ...currentPlan, id: matchedCurrentPlan.id };
    }
  }

  const planDicts = availablePlans.map(p => ({
    id: p.id,
    retailer_id: p.retailerId,
    name: p.name,
    region: p.region ?? undefined,
    c_per_kwh: p.cPerKwh ?? undefined,
    c_per_day: p.cPerDay ?? undefined,
    tier_thresholds_json: p.tierThresholdsJson ?? undefined,
    prompt_payment_discount: p.promptPaymentDiscount ?? undefined,
    conditions_json: p.conditionsJson ?? undefined,
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

  // 6. POST to Python /compare via the typed boundary primitive
  const results = await comparePlans(
    {
      usageProfile,
      currentPlan,
      availablePlans: planDicts,
      billHistory: billSummaries,
    },
    env
  );

  // Log warning if savings don't cover exit fees
  if (latestBill.breakFeeCents != null) {
    for (const item of results) {
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
  for (const item of results) {
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
    plansCompared: results.length,
    storedResults: comparisonIds.length,
    timestamp: new Date().toISOString(),
  }));

  return comparisonIds.length > 0 ? comparisonIds[0]! : null;
}
