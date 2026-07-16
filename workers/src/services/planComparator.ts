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
import { getLatestSwitchForUser } from '../models/switches';
import type {
  ComparisonBillSummary,
  ComparisonCurrentPlan,
  ComparisonInput,
  ComparisonResult,
  ComparisonUsageProfile,
  NotifyQueuePayload,
} from '../types/comparison';

interface CompareEnv {
  readonly DB: D1Database;
  // KV is optional on the env so the compare-queue dispatch in index.ts does
  // not need a parallel edit (Issue #75 owns index.ts this wave). When present,
  // AC #74 comparison_id dedup is armed; when absent, notify enqueues without
  // dedup (trace-logged). Wiring KV through index.ts is a one-line follow-up.
  readonly KV?: KVNamespace;
  readonly NOTIFY_QUEUE: Queue<NotifyQueuePayload>;
  readonly SENT_API_KEY: string;
  readonly PYTHON_SERVICE_URL?: string;
  readonly PYTHON_SERVICE_AUTH_TOKEN?: string;
}

// AC #74 — idempotency: skip enqueuing a notify for a comparison_id that was
// already notified. KV key per comparison; TTL matches the notify cooldown
// window so a re-compare that produces a fresh comparison_id can notify later.
export const NOTIFIED_KEY_PREFIX = 'notified:';
const NOTIFIED_KEY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

  // Boundary serialization: the Python /compare contract is snake_case
  // (usage_profile.avg_daily_kwh, bill_history[].usage_kwh, …) while the TS
  // types are camelCase. Sending the input verbatim made Python 400 with
  // "current_plan is required" — found live in the #242 test run (unit tests
  // mock this fetch, so CI never exercised the real contract).
  const wireBody = {
    usage_profile: {
      avg_daily_kwh: input.usageProfile.avgDailyKwh,
      meter_type: input.usageProfile.meterType,
      seasonal_weight: input.usageProfile.seasonalWeights,
    },
    current_plan: input.currentPlan,
    available_plans: input.availablePlans,
    bill_history: input.billHistory.map((b) => ({
      id: b.id,
      usage_kwh: b.usageKwh,
      total_cents: b.totalCents,
      period_start: b.periodStart,
      period_end: b.periodEnd,
      days: b.days,
      break_fee_cents: b.breakFeeCents,
    })),
  };
  const response = await fetch(`${pythonUrl}/compare`, {
    method: 'POST',
    headers,
    body: JSON.stringify(wireBody),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`Python compare service returned ${response.status}`);
  }

  // Python server returns the bare ranked list (jsonify(results)).
  return (await response.json()) as ComparisonResult;
}

const SAVING_THRESHOLD_CENTS = 5000; // $50 NZD minimum saving to notify

// AC #72 — recent_switch cooldown: if the user switched within this window,
// override the recommendation to stay_put / recent_switch. PRD 5.3 does not
// pin a duration; 90 days aligns with typical NZ fixed-term minimum lengths.
const RECENT_SWITCH_COOLDOWN_DAYS = 90;

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
 * Outcome of runComparison. When no comparison row was produced,
 * `skipReason` carries the TRUE cause so the flow trace never reports
 * "no parsed bills" for a user whose bill did parse (deployed-run finding).
 */
export interface ComparisonRunOutcome {
  readonly comparisonId: string | null;
  readonly skipReason?: string;
}

/**
 * Run a full plan comparison for a user after a new bill is parsed.
 * Called from the compare queue consumer.
 */
export async function runComparison(
  userId: string,
  env: CompareEnv
): Promise<ComparisonRunOutcome> {
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
    return { comparisonId: null, skipReason: 'no parsed bills' };
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
    return { comparisonId: null, skipReason: 'parsed bills missing required fields (usage/total/period)' };
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
    return { comparisonId: null, skipReason: `no plans available for region ${region}` };
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

  // AC #72 — recent_switch cooldown. Python stamps recommendation/reason from
  // money math; the cooldown is a DB-read, so TS owns this override. If the
  // user's most recent switch is inside the window, force stay_put regardless
  // of what the numbers say.
  const latestSwitch = await getLatestSwitchForUser(env.DB, userId);
  let overriddenResults = results;
  if (latestSwitch && _isWithinCooldown(latestSwitch.requestedAt, RECENT_SWITCH_COOLDOWN_DAYS)) {
    overriddenResults = results.map(item => ({
      ...item,
      recommendation: 'stay_put' as const,
      reason: 'recent_switch' as const,
    }));
    console.log(JSON.stringify({
      type: 'compare_recent_switch_override',
      userId,
      lastSwitchAt: latestSwitch.requestedAt,
      cooldownDays: RECENT_SWITCH_COOLDOWN_DAYS,
      timestamp: new Date().toISOString(),
    }));
  }

  // Use the cooldown-aware list for everything downstream.
  const finalResults = overriddenResults;

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

  // 7. Store ONE summary row per run (AC #73). The row carries the verdict
  // (recommendation/reason) plus the recommended plan, not one row per
  // candidate. The legacy per-plan columns are populated from the recommended
  // plan so existing readers keep working.
  const switchable = finalResults.filter(
    item => item.recommendation === 'switch' && item.saving_cents > 0
  );
  const topSwitch = switchable.length > 0 ? switchable[0] : null;

  // User-level verdict: switch iff a switchable plan exists, else stay_put.
  const recommendation = topSwitch ? 'switch' as const : 'stay_put' as const;

  // Recommended plan = the top switchable plan, else the current plan on stay.
  const verdictItem = topSwitch ?? finalResults.find(
    item => item.recommendation === 'stay_put'
  ) ?? finalResults[0]!;

  const matchedRecommended = availablePlans.find(
    p => p.retailerId === verdictItem.retailer_id && p.name === verdictItem.plan_name
  );
  if (!matchedRecommended) {
    console.log(JSON.stringify({
      type: 'compare_skip',
      userId,
      reason: 'recommended plan not matchable',
      timestamp: new Date().toISOString(),
    }));
    return { comparisonId: null, skipReason: 'recommended plan not matchable' };
  }

  // reason is only set by Python on stay_put; carry it through when present.
  const reason = verdictItem.reason ?? null;

  const comparison = await createComparison(env.DB, {
    userId,
    billIdsJson: JSON.stringify(billSummaries.map(b => b.id)),
    currentCostCents: verdictItem.current_cost_cents,
    confidence: verdictItem.confidence,
    // AC #73 summary columns. The NOT NULL legacy columns (plan_id /
    // projected_cost_cents / saving_cents) are derived from these inside
    // createComparison.
    billId: latestBill.id,
    currentPlanId: currentPlan.id ?? null,
    recommendedPlanId: matchedRecommended.id,
    projectedAnnualCost: verdictItem.projected_cost_cents,
    savings: verdictItem.saving_cents,
    recommendation,
    reason,
  });

  // 8. Enqueue notification only on a switch verdict that clears the saving
  // threshold. stay_put (any reason) must never trigger a switch nudge.
  // AC #74 — idempotent on comparison_id: skip if already notified (KV marker).
  if (
    recommendation === 'switch' &&
    topSwitch != null &&
    topSwitch.saving_cents > SAVING_THRESHOLD_CENTS
  ) {
    const dedupKey = `${NOTIFIED_KEY_PREFIX}${comparison.id}`;
    const alreadyNotified = env.KV ? await env.KV.get(dedupKey) : null;
    if (alreadyNotified !== null) {
      console.log(JSON.stringify({
        type: 'compare_notify_skip_dedup',
        userId,
        comparisonId: comparison.id,
        reason: 'comparison_id already notified',
        timestamp: new Date().toISOString(),
      }));
    } else {
      // Set the idempotency marker BEFORE sending so a concurrent producer
      // (or a retry) cannot double-enqueue for the same comparison_id.
      if (env.KV) {
        await env.KV.put(dedupKey, new Date().toISOString(), {
          expirationTtl: NOTIFIED_KEY_TTL_SECONDS,
        });
      }
      const payload: NotifyQueuePayload = {
        userId,
        comparisonId: comparison.id,
        billId: latestBill.id,
        recommendation,
      };
      await env.NOTIFY_QUEUE.send(payload);
      // AC #74 — trace log linking comparison_id → notify dispatch.
      console.log(JSON.stringify({
        type: 'compare_enqueued_notification',
        userId,
        comparisonId: comparison.id,
        billId: latestBill.id,
        recommendation,
        savingCents: topSwitch.saving_cents,
        notifyDedupKey: env.KV ? dedupKey : null,
        dedupArmed: env.KV !== undefined,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  console.log(JSON.stringify({
    type: 'compare_complete',
    userId,
    plansCompared: finalResults.length,
    recommendation,
    comparisonId: comparison.id,
    timestamp: new Date().toISOString(),
  }));

  return { comparisonId: comparison.id };
}

/**
 * Return true if *isoDate* is within *days* of now (i.e. the cooldown has not
 * elapsed). AC #72 recent_switch check.
 */
function _isWithinCooldown(isoDate: string, days: number): boolean {
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return false;
  const elapsedMs = Date.now() - then;
  return elapsedMs >= 0 && elapsedMs < days * 24 * 60 * 60 * 1000;
}
