import type { Bill, CreateBillInput, UpdateBillParsedData, BillStatus } from '../types/bill';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToBill(row: Record<string, unknown>): Bill {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    retailerId: row.retailer_id as string | null,
    planName: row.plan_name as string | null,
    meterType: row.meter_type as Bill['meterType'],
    periodStart: row.period_start as string | null,
    periodEnd: row.period_end as string | null,
    days: row.days as number | null,
    usageKwh: row.usage_kwh as number | null,
    totalCents: row.total_cents as number | null,
    cPerKwh: row.c_per_kwh as number | null,
    cPerDay: row.c_per_day as number | null,
    fixedTermExpiry: row.fixed_term_expiry as string | null,
    breakFeeCents: row.break_fee_cents as number | null,
    status: row.status as BillStatus,
    confidence: row.confidence as number | null,
    rawR2Key: row.raw_r2_key as string | null,
    parsedJson: row.parsed_json as string | null,
    source: row.source as Bill['source'],
    createdAt: row.created_at as string,
  };
}

/**
 * Create a new bill record.
 */
export async function createBill(
  db: D1Database,
  input: CreateBillInput
): Promise<Bill> {
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO bills (id, user_id, retailer_id, raw_r2_key, source, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending_parse', ?6)`
  );

  await stmt
    .bind(id, input.userId, input.retailerId ?? null, input.rawR2Key, input.source ?? null, now)
    .run();

  const bill = await getBillById(db, id);
  if (!bill) throw new Error('Failed to create bill');
  return bill;
}

/**
 * Get a bill by its primary key ID.
 */
export async function getBillById(
  db: D1Database,
  id: string
): Promise<Bill | null> {
  const stmt = db.prepare('SELECT * FROM bills WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToBill(result);
}

/**
 * Get all bills for a user, ordered by creation date descending.
 */
export async function getBillsByUserId(
  db: D1Database,
  userId: string
): Promise<readonly Bill[]> {
  const stmt = db.prepare(
    'SELECT * FROM bills WHERE user_id = ?1 ORDER BY created_at DESC'
  );
  const results = await stmt.bind(userId).all<Record<string, unknown>>();

  return results.results?.map(rowToBill) ?? [];
}

/**
 * Update the status of a bill (e.g., move from 'pending_parse' to 'parsing').
 */
export async function updateBillStatus(
  db: D1Database,
  id: string,
  status: BillStatus
): Promise<void> {
  const stmt = db.prepare('UPDATE bills SET status = ?1 WHERE id = ?2');
  await stmt.bind(status, id).run();
}

/**
 * Update a bill with parsed data after the Python parser completes.
 */
export async function updateBillParsedData(
  db: D1Database,
  id: string,
  data: UpdateBillParsedData
): Promise<void> {
  const _now = new Date().toISOString();

  const stmt = db.prepare(
    `UPDATE bills SET
      retailer_id = ?1,
      plan_name = ?2,
      meter_type = ?3,
      period_start = ?4,
      period_end = ?5,
      days = ?6,
      usage_kwh = ?7,
      total_cents = ?8,
      c_per_kwh = ?9,
      c_per_day = ?10,
      fixed_term_expiry = ?11,
      break_fee_cents = ?12,
      confidence = ?13,
      parsed_json = ?14,
      status = ?15
     WHERE id = ?16`
  );

  await stmt
    .bind(
      data.retailerId ?? null,
      data.planName ?? null,
      data.meterType ?? null,
      data.periodStart ?? null,
      data.periodEnd ?? null,
      data.days ?? null,
      data.usageKwh ?? null,
      data.totalCents ?? null,
      data.cPerKwh ?? null,
      data.cPerDay ?? null,
      data.fixedTermExpiry ?? null,
      data.breakFeeCents ?? null,
      data.confidence ?? null,
      data.parsedJson ?? null,
      data.status,
      id
    )
    .run();
}
