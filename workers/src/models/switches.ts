import type {
  Switch,
  SwitchStatus,
  SwitchTransition,
  SwitchTransitionActor,
} from '../types/switch';

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
    confirmedAt: (row.confirmed_at as string | null | undefined) ?? null,
    completedAt: (row.completed_at as string | null | undefined) ?? null,
    failureReason: (row.failure_reason as string | null | undefined) ?? null,
  };
}

function rowToTransition(row: Record<string, unknown>): SwitchTransition {
  return {
    id: row.id as string,
    switchId: row.switch_id as string,
    fromStatus: (row.from_status as SwitchStatus | null | undefined) ?? null,
    toStatus: row.to_status as SwitchStatus,
    actor: row.actor as SwitchTransitionActor,
    reason: (row.reason as string | null | undefined) ?? null,
    at: row.at as string,
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
 * Get the active (non-terminal) switch for a user + plan, if any.
 * Active statuses: requested, confirmed, in_progress.
 *
 * Issue #130 AC: a user MUST NOT have two active switches for the SAME plan.
 * A user MAY have active switches for DIFFERENT plans — this helper is scoped
 * to (user, plan), unlike `getActiveSwitchForUser` which is user-only.
 * Mirrors `getActiveSwitchForUser` exactly + `AND to_plan_id = ?`.
 */
export async function getActiveSwitchForUserAndPlan(
  db: D1Database,
  userId: string,
  planId: string
): Promise<Switch | null> {
  const stmt = db.prepare(
    `SELECT * FROM switches
     WHERE user_id = ?1
       AND to_plan_id = ?2
       AND status IN ('requested', 'confirmed', 'in_progress')
     ORDER BY requested_at DESC
     LIMIT 1`
  );
  const result = await stmt.bind(userId, planId).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToSwitch(result);
}

/**
 * Get the user's most recent switch (any status), newest first.
 * Used by AC #72 recent_switch cooldown: if the newest switch falls inside
 * the cooldown window, the comparison recommendation is overridden to stay_put.
 */
export async function getLatestSwitchForUser(
  db: D1Database,
  userId: string
): Promise<Switch | null> {
  const stmt = db.prepare(
    `SELECT * FROM switches
     WHERE user_id = ?1
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
 * Sets failure_reason when provided (issue #129 migration 0016; consumed by #132).
 */
export async function updateSwitchStatus(
  db: D1Database,
  id: string,
  status: SwitchStatus,
  failureReason?: string | null
): Promise<void> {
  const now = new Date().toISOString();

  const sets: string[] = ['status = ?1'];
  const params: unknown[] = [status];

  if (status === 'confirmed') {
    sets.push('confirmed_at = ?2');
    params.push(now);
  } else if (status === 'completed') {
    sets.push('completed_at = ?2');
    params.push(now);
  }
  if (failureReason !== undefined) {
    // ponytail: append failure_reason only when supplied so non-failed paths
    // don't clobber a previously stored reason. Bind index continues from
    // current length + 1.
    params.push(failureReason);
    sets.push(`failure_reason = ?${params.length}`);
  }
  params.push(id);

  const sql = `UPDATE switches SET ${sets.join(', ')} WHERE id = ?${params.length}`;
  const stmt = db.prepare(sql);
  await stmt.bind(...params).run();
}

// ---------------------------------------------------------------------------
// Issue #129 — switch state-machine transition log (migration 0016).
// ---------------------------------------------------------------------------

/**
 * Persist one transition row to `switch_transitions`. Called by the
 * switchService.transitionSwitch boundary after a status change succeeds.
 * `fromStatus` is null only on the initial creation row.
 */
export async function createSwitchTransition(
  db: D1Database,
  input: {
    readonly switchId: string;
    readonly fromStatus: SwitchStatus | null;
    readonly toStatus: SwitchStatus;
    readonly actor: SwitchTransitionActor;
    readonly reason?: string | null;
  }
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO switch_transitions (id, switch_id, from_status, to_status, actor, reason, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(
      id,
      input.switchId,
      input.fromStatus,
      input.toStatus,
      input.actor,
      input.reason ?? null,
      now
    )
    .run();

  return id;
}

/**
 * List the transition history for one switch, oldest-first. Used by ops/admin
 * to reconstruct a switch lifecycle. AC #129 "All transitions logged".
 */
export async function listSwitchTransitions(
  db: D1Database,
  switchId: string
): Promise<readonly SwitchTransition[]> {
  const result = await db
    .prepare(
      `SELECT * FROM switch_transitions WHERE switch_id = ?1 ORDER BY at ASC`
    )
    .bind(switchId)
    .all<Record<string, unknown>>();

  return result.results?.map(rowToTransition) ?? [];
}
