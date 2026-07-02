import type { Plan, PlanSource } from '../types/plan';

/** Minimal plan shape consumed by the powerswitch upsert (#66). Disjoint from
 *  the eiep14a.ts upsert path: provenance is always 'powerswitch' and manual
 *  rows are never overwritten. */
export interface PowerswitchPlanInput {
  readonly retailer: string;
  readonly retailerId: string;
  readonly planName: string;
  readonly region: string;
  readonly cPerKwh: number | null;
  readonly cPerDay: number | null;
  readonly promptPaymentDiscount: number | null;
  readonly lowUserEligible: boolean;
  readonly conditions: Record<string, unknown>;
  readonly sourceUrl: string;
}

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

/** Issue #68 — the kind of plan change detected by upsertPlan. */
export type PlanChangeType = 'created' | 'updated' | 'unchanged';

export interface UpsertPlanResult {
  readonly plan: Plan;
  readonly changeType: PlanChangeType;
  /** Field names that differ between old and new (empty unless changeType === 'updated'). */
  readonly changedFields: readonly string[];
  /** Retailer id of the affected plan, for grouping KV diffs. */
  readonly retailerId: string;
  /** Old plan id that was retired (is_current=0); null unless changeType === 'updated'. */
  readonly retiredPlanId: string | null;
}

/**
 * Upsert a plan by eiep14a_id (used for bulk imports from the Electricity Authority).
 * #64: hash-based idempotency — when input.contentHash matches the stored
 * content_hash, the row is returned unchanged (change_type 'unchanged').
 * #68: versioned upsert — on a hash mismatch the old row is retired
 * (is_current=0, effective_to=now) and a fresh is_current=1 row is inserted
 * rather than mutating the old row in place.
 */
export async function upsertPlan(
  db: D1Database,
  input: Omit<Plan, 'id'>
): Promise<UpsertPlanResult> {
  if (!input.eiep14aId) {
    const plan = await createPlan(db, input);
    return { plan, changeType: 'created', changedFields: [], retailerId: plan.retailerId, retiredPlanId: null };
  }

  // Check if a plan with this eiep14a_id already exists.
  const existing = db.prepare(
    'SELECT id, content_hash FROM plans WHERE eiep14a_id = ?1'
  );
  const existingRow = await existing.bind(input.eiep14aId).first<{ id: string; content_hash: string | null } | null>();

  if (existingRow) {
    // #64 fast path: hash-based idempotency — skip the write when the tracked-field
    // hash already matches the stored content_hash.
    if (input.contentHash && existingRow.content_hash === input.contentHash) {
      const plan = await getPlanById(db, existingRow.id);
      if (!plan) throw new Error('Failed to upsert plan');
      return { plan, changeType: 'unchanged', changedFields: [], retailerId: plan.retailerId, retiredPlanId: null };
    }

    // #68: hash differs → versioned replace. Read the full old row so we can
    // name which fields changed (for the KV diff payload), then retire it.
    const oldPlan = await getPlanById(db, existingRow.id);
    const changedFields = oldPlan ? computeChangedFields(oldPlan, input) : [];
    await retirePlan(db, existingRow.id, input.ingestedAt ?? null);

    const newPlan = await createPlan(db, input);
    return { plan: newPlan, changeType: 'updated', changedFields, retailerId: newPlan.retailerId, retiredPlanId: existingRow.id };
  }

  const plan = await createPlan(db, input);
  return { plan, changeType: 'created', changedFields: [], retailerId: plan.retailerId, retiredPlanId: null };
}

/** Mark an existing plan row as no longer current (#68 versioned upsert). */
async function retirePlan(db: D1Database, id: string, effectiveTo: string | null): Promise<void> {
  await db
    .prepare('UPDATE plans SET is_current = 0, effective_to = ?1 WHERE id = ?2')
    .bind(effectiveTo ?? new Date().toISOString(), id)
    .run();
}

/**
 * #68 — name the tracked fields that differ between an existing plan row and
 * the incoming input. Field names match the KV diff payload contract. Empty
 * when nothing changed (should not happen when content_hash differs, but the
 * helper is defensive).
 */
export function computeChangedFields(
  old: Pick<Plan, 'cPerKwh' | 'cPerDay' | 'tierThresholdsJson' | 'promptPaymentDiscount' | 'conditionsJson' | 'lowUserEligible' | 'region' | 'name'>,
  next: Pick<Plan, 'cPerKwh' | 'cPerDay' | 'tierThresholdsJson' | 'promptPaymentDiscount' | 'conditionsJson' | 'lowUserEligible' | 'region' | 'name'>
): string[] {
  const changed: string[] = [];
  if ((old.cPerKwh ?? null) !== (next.cPerKwh ?? null)) changed.push('c_per_kwh');
  if ((old.cPerDay ?? null) !== (next.cPerDay ?? null)) changed.push('c_per_day');
  if ((old.tierThresholdsJson ?? null) !== (next.tierThresholdsJson ?? null)) changed.push('tier_thresholds_json');
  if ((old.promptPaymentDiscount ?? null) !== (next.promptPaymentDiscount ?? null)) changed.push('prompt_payment_discount');
  if ((old.conditionsJson ?? null) !== (next.conditionsJson ?? null)) changed.push('conditions_json');
  if (Boolean(old.lowUserEligible) !== Boolean(next.lowUserEligible)) changed.push('low_user_eligible');
  if ((old.region ?? null) !== (next.region ?? null)) changed.push('region');
  if ((old.name ?? null) !== (next.name ?? null)) changed.push('name');
  return changed;
}

/**
 * #69 — Incomplete-row predicate. A plan is incomplete (and thus excluded from
 * switch recommendations) when it carries neither a flat c_per_kwh rate NOR a
 * tier_thresholds_json schedule — i.e. there is no way to price a bill against
 * it. Kept as an exported helper so the aggregator and tests share one
 * definition of "incomplete".
 */
export function isIncompletePlan(plan: Pick<Plan, 'cPerKwh' | 'tierThresholdsJson'>): boolean {
  return plan.cPerKwh === null && plan.tierThresholdsJson === null;
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

/**
 * #66 — Upsert a Powerswitch-scraped plan. Disjoint from upsertPlan (eiep14a):
 * keyed by (retailer_id, name, region) rather than eiep14a_id, and CRITICALLY
 * never overwrites an existing provenance='manual' row — manual data always
 * wins. Returns { changed, blockedByManual }.
 */
export async function upsertPowerswitchPlan(
  db: D1Database,
  input: { plan: PowerswitchPlanInput; ingestedAt: string }
): Promise<{ changed: boolean; blockedByManual: boolean }> {
  const { plan, ingestedAt } = input;
  const conditionsJson = JSON.stringify(plan.conditions);

  // Look for an existing row on the natural key (retailer_id, name, region).
  const existing = await db
    .prepare(
      `SELECT id, provenance FROM plans
       WHERE retailer_id = ?1 AND name = ?2 AND COALESCE(region, '') = COALESCE(?3, '')`
    )
    .bind(plan.retailerId, plan.planName, plan.region)
    .first<{ id: string; provenance: string | null } | null>();

  if (existing) {
    // Manual-protection: never overwrite a manually curated row.
    if (existing.provenance === 'manual') {
      return { changed: false, blockedByManual: true };
    }
    await db
      .prepare(
        `UPDATE plans SET
           retailer_id = ?1, name = ?2, region = ?3, c_per_kwh = ?4, c_per_day = ?5,
           prompt_payment_discount = ?6, conditions_json = ?7,
           low_user_eligible = ?8, source = ?9, effective_from = ?10,
           provenance = ?11, source_url = ?12, ingested_at = ?13, is_current = 1
         WHERE id = ?14`
      )
      .bind(
        plan.retailerId,
        plan.planName,
        plan.region,
        plan.cPerKwh,
        plan.cPerDay,
        plan.promptPaymentDiscount,
        conditionsJson,
        plan.lowUserEligible ? 1 : 0,
        'powerswitch',
        ingestedAt,
        'powerswitch',
        plan.sourceUrl,
        ingestedAt,
        existing.id
      )
      .run();
    return { changed: true, blockedByManual: false };
  }

  // Insert new row.
  await db
    .prepare(
      `INSERT INTO plans (
         id, retailer_id, name, region, c_per_kwh, c_per_day,
         tier_thresholds_json, prompt_payment_discount, conditions_json,
         low_user_eligible, source, eiep14a_id, effective_from, effective_to,
         provenance, source_url, ingested_at, content_hash, is_current
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, NULL, ?11, NULL, ?12, ?13, ?14, NULL, 1)`
    )
    .bind(
      generateId(),
      plan.retailerId,
      plan.planName,
      plan.region,
      plan.cPerKwh,
      plan.cPerDay,
      plan.promptPaymentDiscount,
      conditionsJson,
      plan.lowUserEligible ? 1 : 0,
      'powerswitch',
      ingestedAt,
      'powerswitch',
      plan.sourceUrl,
      ingestedAt
    )
    .run();
  return { changed: true, blockedByManual: false };
}
