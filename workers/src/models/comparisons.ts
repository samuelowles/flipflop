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
  };
}

/**
 * Create a new plan comparison result.
 */
export async function createComparison(
  db: D1Database,
  input: Omit<PlanComparison, 'id' | 'comparedAt'>
): Promise<PlanComparison> {
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO plan_comparisons (
      id, user_id, plan_id, bill_ids_json,
      projected_cost_cents, current_cost_cents, saving_cents,
      confidence, compared_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
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
      now
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
