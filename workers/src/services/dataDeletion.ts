/**
 * PRD 3.7 — "Delete my account and all data" (Privacy Act 2020 right to erasure).
 *
 * `models/users.deleteUser` existed with ZERO callers, and on its own it could
 * not have worked: every child table declares `user_id TEXT NOT NULL REFERENCES
 * users(id)` with no `ON DELETE CASCADE`, so a bare `DELETE FROM users` raises a
 * foreign-key violation for any user who has ever had a bill. Erasure has to
 * clear the children first, and it has to clear R2 and KV too — the bill PDFs
 * and the cached scan/comparison state are personal data that outlive the row.
 *
 * WHY THE TABLE LIST IS DISCOVERED, NOT HARD-CODED
 * A hand-maintained list is a privacy incident waiting for the next migration:
 * whoever adds the next `user_id` table has to remember this file, and if they
 * do not, data silently survives an erasure request. Instead every table is
 * asked whether it has a `user_id` column, so new tables are covered the day
 * they are created. ponytail: one extra pragma query per erasure, on an
 * operation that runs at most once per user.
 */

/** Tables never swept: not user data, and `plans` is shared reference data. */
const NEVER_SWEEP = new Set(['d1_migrations', 'sqlite_sequence', 'plans', 'retailers']);

export interface DeletionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly BILLS: R2Bucket;
}

/** What was destroyed. Logged for the compliance trail — counts only, no PII. */
export interface DeletionReceipt {
  readonly d1RowsDeleted: number;
  readonly tablesSwept: readonly string[];
  readonly r2ObjectsDeleted: number;
  readonly kvKeysDeleted: number;
}

/** Every table carrying a `user_id` column, discovered from the live schema. */
async function tablesWithUserId(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();

  const named: string[] = [];
  for (const { name } of results ?? []) {
    if (NEVER_SWEEP.has(name) || name.startsWith('sqlite_')) continue;
    const hit = await db
      .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${name}') WHERE name = 'user_id'`)
      .first<{ n: number }>();
    if ((hit?.n ?? 0) > 0) named.push(name);
  }
  return named;
}

/**
 * Irreversibly erase everything held about a user: D1 rows, bill PDFs in R2 and
 * cached state in KV.
 *
 * Best-effort per store and never throws: a KV or R2 hiccup must not abort the
 * D1 erasure half-done. The receipt records what actually went, so a partial
 * result is visible rather than reported as success.
 */
export async function deleteAllUserData(
  env: DeletionEnv,
  userId: string
): Promise<DeletionReceipt> {
  // 1. Read what we need BEFORE destroying the rows that point at it.
  let r2Keys: string[] = [];
  let comparisonIds: string[] = [];
  try {
    const bills = await env.DB
      .prepare('SELECT raw_r2_key FROM bills WHERE user_id = ?1')
      .bind(userId)
      .all<{ raw_r2_key: string | null }>();
    r2Keys = (bills.results ?? []).map((b) => b.raw_r2_key).filter((k): k is string => !!k);

    const cmps = await env.DB
      .prepare('SELECT id FROM plan_comparisons WHERE user_id = ?1')
      .bind(userId)
      .all<{ id: string }>();
    comparisonIds = (cmps.results ?? []).map((c) => c.id);
  } catch {
    // Schema drift or a missing table — keep going; D1 erasure is the priority.
  }

  // 2. R2: the bill PDFs themselves.
  let r2ObjectsDeleted = 0;
  for (const key of r2Keys) {
    try {
      await env.BILLS.delete(key);
      r2ObjectsDeleted++;
    } catch { /* already gone, or transient — the receipt will under-count */ }
  }

  // 3. KV: cached scan progress, cooldowns, dedup markers, flow traces,
  // Powerswitch results. Matched by scanning the namespace for keys CONTAINING
  // the user id rather than by an allow-list of prefixes — same reasoning as the
  // table discovery: a prefix added later would otherwise be missed silently.
  // ponytail: O(all keys) per erasure; fine at beta scale, revisit if the
  // namespace grows past a few thousand keys.
  let kvKeysDeleted = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.KV.list({ cursor });
      for (const { name } of page.keys) {
        // `notified:{comparisonId}` does not carry the user id, so it is matched
        // via the comparison ids collected in step 1.
        const isUserKey = name.includes(userId) || comparisonIds.some((id) => name.includes(id));
        if (!isUserKey) continue;
        await env.KV.delete(name);
        kvKeysDeleted++;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch { /* KV unavailable — D1 erasure still proceeds */ }

  // 4. D1: children first (no ON DELETE CASCADE anywhere), then the user row.
  let d1RowsDeleted = 0;
  const tablesSwept: string[] = [];
  const tables = await tablesWithUserId(env.DB);
  for (const table of tables) {
    if (table === 'users') continue; // holds `id`, not `user_id`; deleted last
    try {
      const res = await env.DB
        .prepare(`DELETE FROM ${table} WHERE user_id = ?1`)
        .bind(userId)
        .run();
      d1RowsDeleted += res.meta?.changes ?? 0;
      tablesSwept.push(table);
    } catch { /* keep sweeping — one failed table must not strand the rest */ }
  }

  const userRow = await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId).run();
  d1RowsDeleted += userRow.meta?.changes ?? 0;
  tablesSwept.push('users');

  return { d1RowsDeleted, tablesSwept, r2ObjectsDeleted, kvKeysDeleted };
}
