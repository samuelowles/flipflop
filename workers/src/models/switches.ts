import type { Switch, SwitchStatus } from '../types/switch';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToSwitch(row: Record<string, unknown>): Switch {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    fromRetailerId: row.from_retailer_id as string,
    toPlanId: row.to_plan_id as string,
    status: row.status as SwitchStatus,
    requestedAt: row.requested_at as string,
    confirmedAt: row.confirmed_at as string | null,
    completedAt: row.completed_at as string | null,
  };
}

/**
 * Create a new switch request.
 */
export async function createSwitch(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly fromRetailerId: string;
    readonly toPlanId: string;
  }
): Promise<Switch> {
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO switches (id, user_id, from_retailer_id, to_plan_id, status, requested_at)
     VALUES (?1, ?2, ?3, ?4, 'requested', ?5)`
  );

  await stmt
    .bind(id, input.userId, input.fromRetailerId, input.toPlanId, now)
    .run();

  const switchRecord = await getSwitchById(db, id);
  if (!switchRecord) throw new Error('Failed to create switch');
  return switchRecord;
}

/**
 * Get a switch by its primary key ID.
 */
export async function getSwitchById(
  db: D1Database,
  id: string
): Promise<Switch | null> {
  const stmt = db.prepare('SELECT * FROM switches WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToSwitch(result);
}

/**
 * Get the active (non-terminal) switch for a user, if any.
 * Active statuses: requested, confirmed, in_progress.
 */
export async function getActiveSwitchForUser(
  db: D1Database,
  userId: string
): Promise<Switch | null> {
  const stmt = db.prepare(
    `SELECT * FROM switches
     WHERE user_id = ?1
       AND status IN ('requested', 'confirmed', 'in_progress')
     ORDER BY requested_at DESC
     LIMIT 1`
  );
  const result = await stmt.bind(userId).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToSwitch(result);
}

/**
 * Update the status of a switch.
 * Sets confirmed_at when status changes to 'confirmed'.
 * Sets completed_at when status changes to 'completed'.
 */
export async function updateSwitchStatus(
  db: D1Database,
  id: string,
  status: SwitchStatus
): Promise<void> {
  const now = new Date().toISOString();

  let sql: string;
  let params: unknown[];

  if (status === 'confirmed') {
    sql = 'UPDATE switches SET status = ?1, confirmed_at = ?2 WHERE id = ?3';
    params = [status, now, id];
  } else if (status === 'completed') {
    sql = 'UPDATE switches SET status = ?1, completed_at = ?2 WHERE id = ?3';
    params = [status, now, id];
  } else {
    sql = 'UPDATE switches SET status = ?1 WHERE id = ?2';
    params = [status, id];
  }

  const stmt = db.prepare(sql);
  await stmt.bind(...params).run();
}
