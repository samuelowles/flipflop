import type { PlanComparison } from '../types/comparison';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToComparison(row: Record<string, unknown>): PlanComparison {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    planId: row.plan_id as string,
    billIdsJson: row.bill_ids_json as string | null,
    projectedCostCents: row.projected_cost_cents as number,
    currentCostCents: row.current_cost_cents as number,
    savingCents: row.saving_cents as number,
    confidence: row.confidence as number,
    comparedAt: row.compared_at as string,
    // AC #73 summary columns (nullable on legacy rows).
    billId: (row.bill_id as string | null | undefined) ?? null,
    currentPlanId: (row.current_plan_id as string | null | undefined) ?? null,
    recommendedPlanId: (row.recommended_plan_id as string | null | undefined) ?? null,
    projectedAnnualCost: (row.projected_annual_cost as number | null | undefined) ?? null,
    savings: (row.savings as number | null | undefined) ?? null,
    recommendation: (row.recommendation as PlanComparison['recommendation']) ?? null,
    reason: (row.reason as PlanComparison['reason']) ?? null,
    computedAt: (row.computed_at as string | null | undefined) ?? null,
  };
}

/**
 * Input shape for createComparison. The legacy per-plan fields are kept (they
 * still get populated by the post-#73 single-row write so old readers keep
 * working), and the AC #73 summary fields carry the verdict. Either set is
 * acceptable; the #73 write path supplies both.
 */
export interface CreateComparisonInput {
  userId: string;
  planId: string;
  billIdsJson?: string | null;
  projectedCostCents: number;
  currentCostCents: number;
  savingCents: number;
  confidence: number;
  // AC #73 summary fields:
  billId?: string | null;
  currentPlanId?: string | null;
  recommendedPlanId?: string | null;
  projectedAnnualCost?: number | null;
  savings?: number | null;
  recommendation?: 'switch' | 'stay_put' | null;
  reason?: string | null;
  computedAt?: string | null;
}

/**
 * Create a new plan comparison result.
 *
 * Post-#73 this is called once per comparison run with the summary verdict
 * (recommendation/reason/recommended_plan_id). The legacy per-plan fields are
 * populated from the recommended plan so existing readers keep working.
 */
export async function createComparison(
  db: D1Database,
  input: CreateComparisonInput
): Promise<PlanComparison> {
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO plan_comparisons (
      id, user_id, plan_id, bill_ids_json,
      projected_cost_cents, current_cost_cents, saving_cents,
      confidence, compared_at,
      bill_id, current_plan_id, recommended_plan_id,
      projected_annual_cost, savings, recommendation, reason, computed_at
    ) VALUES (
      ?1, ?2, ?3, ?4,
      ?5, ?6, ?7,
      ?8, ?9,
      ?10, ?11, ?12,
      ?13, ?14, ?15, ?16, ?17
    )`
  );

  await stmt
    .bind(
      id,
      input.userId,
      input.planId,
      input.billIdsJson ?? null,
      input.projectedCostCents,
      input.currentCostCents,
      input.savingCents,
      input.confidence,
      now,
      input.billId ?? null,
      input.currentPlanId ?? null,
      input.recommendedPlanId ?? null,
      input.projectedAnnualCost ?? null,
      input.savings ?? null,
      input.recommendation ?? null,
      input.reason ?? null,
      input.computedAt ?? now
    )
    .run();

  const comparison = await getLatestComparisonForUser(db, input.userId);
  if (!comparison) throw new Error('Failed to create comparison');
  return comparison;
}

/**
 * Get the most recent comparison for a user.
 */
export async function getLatestComparisonForUser(
  db: D1Database,
  userId: string
): Promise<PlanComparison | null> {
  const stmt = db.prepare(
    'SELECT * FROM plan_comparisons WHERE user_id = ?1 ORDER BY compared_at DESC LIMIT 1'
  );
  const result = await stmt.bind(userId).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToComparison(result);
}

/**
 * Get all comparisons for a user, ordered by date descending.
 */
export async function getComparisonsByUserId(
  db: D1Database,
  userId: string,
  limit = 10
): Promise<readonly PlanComparison[]> {
  const stmt = db.prepare(
    'SELECT * FROM plan_comparisons WHERE user_id = ?1 ORDER BY compared_at DESC LIMIT ?2'
  );
  const results = await stmt.bind(userId, limit).all<Record<string, unknown>>();

  return results.results?.map(rowToComparison) ?? [];
}
