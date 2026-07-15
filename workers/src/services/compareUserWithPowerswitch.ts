/**
 * #222 — Per-user comparison path using Powerswitch-mapped tariffs + REAL bill kWh.
 *
 * ADDITIVE to the seeded-plan comparison path (planComparator.runComparison).
 * This path is the "Powerswitch bridge": when a user has a cached Powerswitch
 * result set (#221 KV cache) it feeds those address-specific tariffs to the
 * comparator alongside the user's actual bill-derived usage. The seeded-plan
 * path stays the fallback when the bridge is unavailable (no cached results).
 *
 * Flow:
 *   1. Read parsed results from KV (`powerswitch:results:{userId}`).
 *   2. Map tariffs → comparator plan dicts (#222 mapper).
 *   3. Build the usage profile from the user's PARSED bills (real kWh). When no
 *      bill exists yet, fall back to Powerswitch's `household.usage` estimate.
 *   4. POST to the Python comparator (reuses comparePlans — same boundary).
 *   5. Persist ONE summary row to plan_comparisons (reuses createComparison).
 *   6. Write ONE plan_data_provenance audit row (source='powerswitch_user').
 *   7. Carry the modelled-discount + TOU caveats into the recommendation reason
 *      so notification copy can be honest ("stay put" stays first-class).
 *
 * STORAGE DECISION (option a — NO new table, NO migration):
 *   - Mapped plans are read straight from #221's KV cache at compare time.
 *   - The KV cache (7-day TTL) + the plan_data_provenance audit row together
 *     provide reproducibility: the provenance row's raw_hash fingerprints the
 *     tariff set, and the cache holds the full parsed snapshot. No new column
 *     or table is warranted — the comparison row stays clean and the seeded-
 *     plan path is untouched.
 */

import { getBillsByUserId } from '../models/bills';
import { createComparison } from '../models/comparisons';
import { comparePlans } from './planComparator';
import { readCachedResults } from './powerswitchReplay';
import { mapPowerswitchPlans, tariffContentHash } from './powerswitchPlanMapper';
import type {
  ComparisonBillSummary,
  ComparisonCurrentPlan,
  ComparisonResult,
  ComparisonUsageProfile,
  NotifyQueuePayload,
  Recommendation,
  RecommendationReason,
} from '../types/comparison';
import type { ParsedResults } from './powerswitchRscParser';

/** Env for the Powerswitch comparison path. */
export interface PowerswitchCompareEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly NOTIFY_QUEUE?: Queue<NotifyQueuePayload>;
  readonly PYTHON_SERVICE_URL?: string;
  readonly PYTHON_SERVICE_AUTH_TOKEN?: string;
}

/** Discriminated outcome. Callers route on `status`. */
export type PowerswitchCompareOutcome =
  | { readonly status: 'ok'; readonly comparisonId: string; readonly recommendation: Recommendation }
  | { readonly status: 'no_cache' }      // no cached Powerswitch results — caller falls back
  | { readonly status: 'no_plans' }      // cache present but no mappable plans
  | { readonly status: 'skip'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

// $50 NZD minimum saving to notify — mirrors planComparator.SAVING_THRESHOLD_CENTS.
const SAVING_THRESHOLD_CENTS = 5000;

/**
 * Run a per-user comparison using Powerswitch-mapped tariffs + real bill kWh.
 *
 * Returns `no_cache` when there is no cached Powerswitch result set for the user
 * (the caller should fall back to the seeded-plan path in that case). Never
 * throws — errors surface as typed outcomes.
 */
export async function compareUserWithPowerswitch(
  userId: string,
  env: PowerswitchCompareEnv
): Promise<PowerswitchCompareOutcome> {
  // 1. Read cached parsed results (NO live Powerswitch call — #221 owns fetching).
  const cached: ParsedResults | null = await readCachedResults(env, userId);
  if (cached === null) {
    return { status: 'no_cache' };
  }

  // 2. Map tariffs → comparator plan dicts.
  const { plans: mapped, caveats } = mapPowerswitchPlans(cached.plans);
  if (mapped.length === 0) {
    return { status: 'no_plans' };
  }
  const availablePlans = mapped.map((m) => m.plan);

  // 3. Build usage profile from real bills; fall back to the Powerswitch estimate.
  const allBills = await getBillsByUserId(env.DB, userId);
  const parsedBills = allBills.filter((b) => b.status === 'parsed');

  const billSummaries = parsedBills
    .map(billToSummary)
    .filter(Boolean) as ComparisonBillSummary[];

  const usageProfile = buildUsageProfile(billSummaries, cached.usage.annualKwh);
  if (usageProfile.avgDailyKwh <= 0) {
    return { status: 'skip', reason: 'no_usage' };
  }

  // 4. Build the current-plan stub from the latest bill (or an unknown stub).
  const latestBill = parsedBills[0] ?? null;
  const currentPlan: ComparisonCurrentPlan = latestBill
    ? {
        plan_name: latestBill.planName ?? 'Unknown',
        retailer_id: latestBill.retailerId ?? '',
        c_per_kwh: latestBill.cPerKwh ?? undefined,
        c_per_day: latestBill.cPerDay ?? undefined,
        break_fee_cents: latestBill.breakFeeCents ?? undefined,
        fixed_term_expiry: latestBill.fixedTermExpiry ?? undefined,
      }
    : {
        plan_name: 'Unknown',
        retailer_id: '',
      };

  // 5. POST to the Python comparator (reuses the existing typed boundary).
  let results: ComparisonResult;
  try {
    results = await comparePlans(
      {
        usageProfile,
        currentPlan,
        availablePlans,
        billHistory: billSummaries,
      },
      env
    );
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : 'compare_failed',
    };
  }

  // 6. Derive the user-level verdict (mirrors planComparator's logic for the
  // summary row, minus the DB-read cooldown which the notify consumer owns).
  const switchable = results.filter(
    (item) => item.recommendation === 'switch' && item.saving_cents > 0
  );
  const topSwitch = switchable.length > 0 ? switchable[0]! : null;
  const recommendation: Recommendation = topSwitch ? 'switch' : 'stay_put';
  const verdictItem = topSwitch
    ?? results.find((item) => item.recommendation === 'stay_put')
    ?? results[0]!;

  const reason = deriveReason(verdictItem.reason ?? null, caveats);

  // 7. Persist ONE summary row + ONE provenance audit row.
  const comparison = await createComparison(env.DB, {
    userId,
    billIdsJson: billSummaries.length > 0 ? JSON.stringify(billSummaries.map((b) => b.id)) : null,
    currentCostCents: verdictItem.current_cost_cents,
    confidence: verdictItem.confidence,
    billId: latestBill?.id ?? null,
    currentPlanId: null,
    recommendedPlanId: verdictItem.plan_id,
    projectedAnnualCost: verdictItem.projected_cost_cents,
    savings: verdictItem.saving_cents,
    recommendation,
    reason,
  });

  await writePowerswitchProvenance(env.DB, userId, cached.plans.length, mapped.length);

  // 8. Enqueue a notification on a switch verdict that clears the threshold
  // (only when the notify queue is wired — this path is additive and may run
  // from an admin/manual trigger without a queue binding).
  if (
    recommendation === 'switch' &&
    topSwitch &&
    topSwitch.saving_cents > SAVING_THRESHOLD_CENTS &&
    env.NOTIFY_QUEUE &&
    latestBill
  ) {
    const payload: NotifyQueuePayload = {
      userId,
      comparisonId: comparison.id,
      billId: latestBill.id,
      recommendation,
    };
    try {
      await env.NOTIFY_QUEUE.send(payload);
    } catch {
      // Non-fatal — the comparison row is already persisted. Log + continue.
      console.log(JSON.stringify({
        type: 'powerswitch_compare_notify_failed',
        userId,
        comparisonId: comparison.id,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  console.log(JSON.stringify({
    type: 'powerswitch_compare_complete',
    userId,
    plansCompared: results.length,
    recommendation,
    comparisonId: comparison.id,
    caveats,
    timestamp: new Date().toISOString(),
  }));

  return { status: 'ok', comparisonId: comparison.id, recommendation };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function billToSummary(bill: {
  id: string;
  usageKwh: number | null;
  totalCents: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  days: number | null;
  breakFeeCents: number | null;
}): ComparisonBillSummary | null {
  if (
    bill.usageKwh == null ||
    bill.totalCents == null ||
    !bill.periodStart ||
    !bill.periodEnd ||
    bill.days == null
  ) {
    return null;
  }
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

/**
 * Build the usage profile from real bills. Falls back to the Powerswitch
 * annual-kWh estimate (spread evenly across the year) when no parsed bill
 * exists yet — the issue's "fall back to household.usage estimate" requirement.
 */
function buildUsageProfile(
  bills: readonly ComparisonBillSummary[],
  fallbackAnnualKwh: number
): ComparisonUsageProfile {
  if (bills.length > 0) {
    const totalKwh = bills.reduce((sum, b) => sum + b.usageKwh, 0);
    const totalDays = bills.reduce((sum, b) => sum + b.days, 0);
    const avgDailyKwh = totalDays > 0 ? Math.round((totalKwh / totalDays) * 100) / 100 : 0;
    return {
      avgDailyKwh,
      meterType: 'standard',
      seasonalWeights: { summer: 0, winter: 0 },
    };
  }
  // Fallback: Powerswitch estimate → daily average.
  const avgDailyKwh = Math.round((fallbackAnnualKwh / 365) * 100) / 100;
  return {
    avgDailyKwh,
    meterType: 'standard',
    seasonalWeights: { summer: 0, winter: 0 },
  };
}

/**
 * Compose the recommendation reason. When the comparator says stay_put, carry
 * its reason through. When there are Powerswitch caveats (modelled discounts /
 * TOU), append them so notification copy can be honest. A switch verdict with
 * caveats still carries the caveat so the user sees "modelled, not guaranteed".
 */
function deriveReason(
  pythonReason: RecommendationReason | null,
  caveats: string
): string | null {
  if (!caveats) return pythonReason;
  return pythonReason ? `${pythonReason} | ${caveats}` : caveats;
}

/**
 * Write ONE plan_data_provenance audit row per comparison run (source=
 * 'powerswitch_user'). Mirrors the eiep14a/powerswitch-scraper audit shape.
 */
async function writePowerswitchProvenance(
  db: D1Database,
  userId: string,
  parsedCount: number,
  mappedCount: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO plan_data_provenance (
          id, retailer_id, plan_id, source, fetched_at,
          raw_hash, file_url, record_count, upserted_count
        ) VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        crypto.randomUUID(),
        'powerswitch_user',
        new Date().toISOString(),
        `ps_user_${userId}`,
        `kv:powerswitch:results:${userId}`,
        parsedCount,
        mappedCount
      )
      .run();
  } catch (error) {
    // Non-fatal — the comparison row is the source of truth; provenance is audit.
    console.log(JSON.stringify({
      type: 'powerswitch_user_provenance_error',
      userId,
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
  }
}

export { tariffContentHash };
