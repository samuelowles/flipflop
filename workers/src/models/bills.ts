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
    sourceMessageId: row.source_message_id as string | null,
    errorCode: row.error_code as string | null,
    parsedAt: row.parsed_at as string | null,
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
    `INSERT INTO bills (id, user_id, retailer_id, raw_r2_key, source, status, source_message_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending_parse', ?6, ?7)`
  );

  await stmt
    .bind(id, input.userId, input.retailerId ?? null, input.rawR2Key, input.source ?? null, input.sourceMessageId ?? null, now)
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
 * Get a bill by the inbound Sent message id that triggered it.
 * Used for idempotent dispatch: if a bill exists for this message_id,
 * the webhook has already been processed and must not re-enqueue.
 */
export async function getBillBySourceMessageId(
  db: D1Database,
  sourceMessageId: string
): Promise<Bill | null> {
  const stmt = db.prepare('SELECT * FROM bills WHERE source_message_id = ?1');
  const result = await stmt.bind(sourceMessageId).first<Record<string, unknown>>();

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
  const now = new Date().toISOString();

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
      status = ?15,
      parsed_at = ?16
     WHERE id = ?17`
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
      now,
      id
    )
    .run();
}

/**
 * Mark a bill as terminally failed with a short no-PII error code.
 * Used by the parse queue consumer when retries are exhausted or a terminal
 * parse error occurs (4xx, extract_failed, no_media). Issue #39.
 */
export async function updateBillFailed(
  db: D1Database,
  id: string,
  errorCode: string
): Promise<void> {
  const stmt = db.prepare(
    `UPDATE bills SET status = 'failed', error_code = ?1 WHERE id = ?2`
  );
  await stmt.bind(errorCode, id).run();
}

/**
 * Atomically claim the COMPARE_QUEUE enqueue for a bill. Sets
 * compare_enqueued_at only if it is still NULL, returning true when this call
 * won the claim (enqueue should proceed) and false when a prior enqueue for
 * the same bill already happened (enqueue must be skipped — idempotency).
 * Issue #43: guards the parse→compare hop against duplicate PARSE_QUEUE
 * redelivery.
 */
export async function markBillCompareEnqueued(
  db: D1Database,
  id: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE bills SET compare_enqueued_at = ?1 WHERE id = ?2 AND compare_enqueued_at IS NULL`
  );
  const result = await stmt.bind(now, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Issue #78 — return the most recent fixed-term expiry (ISO date) for a user,
 * or null when the user has no fixed-term bill on file. The free-tier check-in
 * uses this to decide the `wait_until_date` variant: if the user is locked into
 * a contract that has not yet expired, switching now is not advised.
 *
 * ponytail: one targeted query beats reusing getBillsByUserId + filter — the
 * check-in only needs the single latest expiry, not the full bill history.
 */
export async function getLatestFixedTermForUser(
  db: D1Database,
  userId: string
): Promise<string | null> {
  const stmt = db.prepare(
    `SELECT fixed_term_expiry FROM bills
     WHERE user_id = ?1 AND fixed_term_expiry IS NOT NULL
     ORDER BY fixed_term_expiry DESC LIMIT 1`
  );
  const result = await stmt.bind(userId).first<{ fixed_term_expiry: string | null }>();
  return result?.fixed_term_expiry ?? null;
}

/**
 * Row shape for getUpcomingFixedTermExpiries (joined bills→users). Carries the
 * minimum fields the expiry notifier (#79) needs to render + send.
 */
export interface UpcomingFixedTermExpiryRow {
  readonly billId: string;
  readonly userId: string;
  readonly phone: string | null;
  /** Date-only YYYY-MM-DD (NZ convention) or full ISO; compared as a date. */
  readonly fixedTermExpiry: string;
  readonly breakFeeCents: number | null;
  /** Retailer display name for the template's {{1}} variable. */
  readonly retailerName: string | null;
}

/**
 * Issue #79 — return bills whose `fixed_term_expiry` falls within `withinDays`
 * days of now, joined to their user. One row per bill (a user with two expiring
 * contracts appears twice — KV dedup is per (user, expiry, window)).
 *
 * `fixed_term_expiry` is stored as YYYY-MM-DD (NZ date-only). SQLite's
 * `julianday` lets us compare date strings without parsing in TS; the bounds
 * are inclusive on both ends so a 7-day-window tick catches expiry == today+7.
 *
 * ponytail: a single bounded query replaces per-user scans; the cron joins all
 * users in one trip instead of N+1 round-trips to D1.
 */
export async function getUpcomingFixedTermExpiries(
  db: D1Database,
  withinDays: number
): Promise<readonly UpcomingFixedTermExpiryRow[]> {
  const stmt = db.prepare(
    `SELECT
       b.id AS bill_id,
       b.user_id,
       u.phone,
       b.fixed_term_expiry,
       b.break_fee_cents,
       r.name AS retailer_name
     FROM bills b
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN retailers r ON r.id = b.retailer_id
     WHERE b.fixed_term_expiry IS NOT NULL
       AND date(b.fixed_term_expiry) >= date('now')
       AND date(b.fixed_term_expiry) <= date('now', '+' || ?1 || ' days')
     ORDER BY b.fixed_term_expiry ASC`
  );
  const result = await stmt.bind(withinDays).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    billId: row.bill_id as string,
    userId: row.user_id as string,
    phone: row.phone as string | null,
    fixedTermExpiry: row.fixed_term_expiry as string,
    breakFeeCents: row.break_fee_cents as number | null,
    retailerName: row.retailer_name as string | null,
  }));
}
