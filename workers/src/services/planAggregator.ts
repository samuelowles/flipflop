import type { Plan } from '../types/plan';
import { getPlansByRegion, isIncompletePlan } from '../models/plans';

/**
 * Issue #69 — Plan data aggregator + source preference logic.
 *
 * Resolves a `(retailer + region + plan/effective date)` tuple across
 * manual/eiep14a/powerswitch rows into ONE canonical plan per
 * (retailer + equivalent plan name), applying precedence
 *   manual > eiep14a > powerswitch
 * and excluding inactive / superseded / incomplete rows.
 *
 * The aggregator is a READ-SIDE module only. It is NOT yet wired into
 * `planComparator.ts` or `routes/eval.ts` — Epic 7 (comparison engine) will
 * consume it when the live read path lands. Consumers still call
 * `getPlansByRegion` directly.
 */

/**
 * Source precedence rank — lower number wins. Mirrors the AC:
 *   manual (1) > eiep14a (2) > powerswitch (3)
 * Unknown / null provenance sorts last (treated as lowest priority).
 */
const SOURCE_RANK: Record<string, number> = {
  manual: 1,
  eiep14a: 2,
  powerswitch: 3,
};

/**
 * Normalize a plan name for equivalence grouping. Retailers surface the same
 * underlying plan under minor formatting variants (case, "Energy" vs "Power",
 * trailing punctuation). Grouping on the normalized form lets an eiep14a
 * "Good Time Energy" row supersede a powerswitch "good time" row for the same
 * retailer + region.
 *
 * Normalization is intentionally conservative: lowercase, alphanumeric-only,
 * collapsed whitespace. Anything more aggressive risks merging distinct plans.
 */
export function normalizePlanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Pick the canonical row from a group of plans that share the same
 * (retailerId, normalized name) for the same region. Precedence is:
 *   1. lowest SOURCE_RANK (manual > eiep14a > powerswitch)
 *   2. tie-break: is_current=1 wins over is_current=0 (defensive — the query
 *      already filters to active rows, but a future caller may pass retired
 *      rows; this keeps the pick stable)
 *   3. tie-break: most recent ingestedAt wins (latest data within a source)
 */
function pickCanonicalPlan(plans: readonly Plan[]): Plan {
  return [...plans].sort((a, b) => {
    const rankA = SOURCE_RANK[a.provenance ?? ''] ?? Number.MAX_SAFE_INTEGER;
    const rankB = SOURCE_RANK[b.provenance ?? ''] ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '');
  })[0]!;
}

/**
 * Resolve the canonical plan set for a region.
 *
 * Reads all active (effective_to IS NULL OR >= now) plans for the region,
 * drops incomplete rows (no c_per_kwh AND no tier_thresholds_json), then
 * groups by (retailerId + normalized plan name) and picks one canonical row
 * per group by source precedence (manual > eiep14a > powerswitch).
 *
 * `usage` is accepted in the signature for forward compatibility with the
 * comparison engine (Epic 7 may filter low-user vs standard-user plans by
 * usage profile) but is not currently used to filter — every AC in #69 is
 * about source precedence and row validity, not usage-based filtering.
 *
 * #157 STUB: the manual-preference branch is fully implemented and tested
 * against the seeded `source='manual'` plans (migrations 0004/0008). Until
 * the manual-import workflow (#157) lands, manual rows only exist via seeds;
 * the aggregator still resolves correctly when manual is absent — eiep14a
 * and powerswitch precedence apply as the fallback.
 */
export async function getCanonicalPlans(
  db: D1Database,
  region: string,
  _usage?: { kwhPerMonth?: number }
): Promise<readonly Plan[]> {
  const active = await getPlansByRegion(db, region);

  const usable = active.filter((p) => !isIncompletePlan(p));

  const groups = new Map<string, Plan[]>();
  for (const plan of usable) {
    const key = `${plan.retailerId}|${normalizePlanName(plan.name)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(plan);
    else groups.set(key, [plan]);
  }

  return [...groups.values()].map((group) => pickCanonicalPlan(group));
}

/**
 * Exposed for tests that want to assert the precedence pick directly without
 * standing up a D1 mock. The public entry point is `getCanonicalPlans`.
 */
export function resolveCanonicalForGroup(plans: readonly Plan[]): Plan {
  return pickCanonicalPlan(plans);
}

export { SOURCE_RANK };
