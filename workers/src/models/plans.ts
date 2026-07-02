import type { Plan, PlanSource } from '../types/plan';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToPlan(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    retailerId: row.retailer_id as string,
    name: row.name as string,
    region: row.region as string | null,
    cPerKwh: row.c_per_kwh as number | null,
    cPerDay: row.c_per_day as number | null,
    tierThresholdsJson: row.tier_thresholds_json as string | null,
    promptPaymentDiscount: row.prompt_payment_discount as number | null,
    conditionsJson: row.conditions_json as string | null,
    lowUserEligible: (row.low_user_eligible as number) === 1,
    source: row.source as PlanSource,
    eiep14aId: row.eiep14a_id as string | null,
    effectiveFrom: row.effective_from as string | null,
    effectiveTo: row.effective_to as string | null,
    provenance: (row.provenance as PlanSource | null) ?? null,
    sourceUrl: row.source_url as string | null,
    ingestedAt: row.ingested_at as string | null,
    contentHash: row.content_hash as string | null,
    isCurrent: (row.is_current as number) === 1,
  };
}

/**
 * Get all plans that apply to a given region.
 */
export async function getPlansByRegion(
  db: D1Database,
  region: string
): Promise<readonly Plan[]> {
  const stmt = db.prepare(
    'SELECT * FROM plans WHERE region = ?1 AND (effective_to IS NULL OR effective_to >= datetime(\'now\')) ORDER BY retailer_id, name'
  );
  const results = await stmt.bind(region).all<Record<string, unknown>>();

  return results.results?.map(rowToPlan) ?? [];
}

/**
 * Get a plan by its primary key ID.
 */
export async function getPlanById(
  db: D1Database,
  id: string
): Promise<Plan | null> {
  const stmt = db.prepare('SELECT * FROM plans WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToPlan(result);
}

/**
 * Create a new plan.
 */
export async function createPlan(
  db: D1Database,
  input: Omit<Plan, 'id'>
): Promise<Plan> {
  const id = generateId();

  const stmt = db.prepare(
    `INSERT INTO plans (
      id, retailer_id, name, region, c_per_kwh, c_per_day,
      tier_thresholds_json, prompt_payment_discount, conditions_json,
      low_user_eligible, source, eiep14a_id, effective_from, effective_to,
      provenance, source_url, ingested_at, content_hash, is_current
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
  );

  await stmt
    .bind(
      id,
      input.retailerId,
      input.name,
      input.region ?? null,
      input.cPerKwh ?? null,
      input.cPerDay ?? null,
      input.tierThresholdsJson ?? null,
      input.promptPaymentDiscount ?? null,
      input.conditionsJson ?? null,
      input.lowUserEligible ? 1 : 0,
      input.source,
      input.eiep14aId ?? null,
      input.effectiveFrom ?? null,
      input.effectiveTo ?? null,
      input.provenance ?? null,
      input.sourceUrl ?? null,
      input.ingestedAt ?? null,
      input.contentHash ?? null,
      input.isCurrent ? 1 : 0
    )
    .run();

  const plan = await getPlanById(db, id);
  if (!plan) throw new Error('Failed to create plan');
  return plan;
}

/**
 * Upsert a plan by eiep14a_id (used for bulk imports from the Electricity Authority).
 * If a plan with the same eiep14a_id exists, update it; otherwise insert.
 */
export async function upsertPlan(
  db: D1Database,
  input: Omit<Plan, 'id'>
): Promise<Plan> {
  if (!input.eiep14aId) {
    return createPlan(db, input);
  }

  // Check if a plan with this eiep14a_id already exists
  const existing = db.prepare(
    'SELECT id FROM plans WHERE eiep14a_id = ?1'
  );
  const existingRow = await existing.bind(input.eiep14aId).first<{ id: string } | null>();

  if (existingRow) {
    // Update existing plan
    const stmt = db.prepare(
      `UPDATE plans SET
        retailer_id = ?1, name = ?2, region = ?3, c_per_kwh = ?4, c_per_day = ?5,
        tier_thresholds_json = ?6, prompt_payment_discount = ?7, conditions_json = ?8,
        low_user_eligible = ?9, source = ?10, effective_from = ?11, effective_to = ?12,
        provenance = ?13, source_url = ?14, ingested_at = ?15, content_hash = ?16,
        is_current = ?17
       WHERE id = ?18`
    );

    await stmt
      .bind(
        input.retailerId,
        input.name,
        input.region ?? null,
        input.cPerKwh ?? null,
        input.cPerDay ?? null,
        input.tierThresholdsJson ?? null,
        input.promptPaymentDiscount ?? null,
        input.conditionsJson ?? null,
        input.lowUserEligible ? 1 : 0,
        input.source,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
        input.provenance ?? null,
        input.sourceUrl ?? null,
        input.ingestedAt ?? null,
        input.contentHash ?? null,
        input.isCurrent ? 1 : 0,
        existingRow.id
      )
      .run();

    const plan = await getPlanById(db, existingRow.id);
    if (!plan) throw new Error('Failed to upsert plan');
    return plan;
  }

  return createPlan(db, input);
}

/**
 * Get all plans for a specific retailer.
 */
export async function getPlansByRetailer(
  db: D1Database,
  retailerId: string
): Promise<readonly Plan[]> {
  const stmt = db.prepare(
    'SELECT * FROM plans WHERE retailer_id = ?1 AND (effective_to IS NULL OR effective_to >= datetime(\'now\')) ORDER BY name'
  );
  const results = await stmt.bind(retailerId).all<Record<string, unknown>>();

  return results.results?.map(rowToPlan) ?? [];
}
