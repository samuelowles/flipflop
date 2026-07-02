import type { User, CreateUserInput, UpdateUserInput } from '../types/user';
import type { ConversationState } from '../types/conversation';
import type { EncryptionEnv } from './encryption';
import { encrypt, decrypt, generatePhoneHash } from './encryption';

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Map a D1 row to the User interface, decrypting PII fields.
 * Reads phone_encrypted first (new), falls back to phone (legacy plaintext).
 */
async function rowToUser(
  row: Record<string, unknown>,
  env: EncryptionEnv
): Promise<User> {
  const name = row.name as string | null;
  const email = row.email as string | null;
  const icpNumber = row.icp_number as string | null;
  const installationAddress = row.installation_address as string | null;

  // Decrypt phone: prefer phone_encrypted column, fall back to legacy phone
  let phone: string;
  const phoneEncrypted = row.phone_encrypted as string | null;
  if (phoneEncrypted) {
    phone = await decrypt(phoneEncrypted, env.ENCRYPTION_KEY);
  } else {
    phone = (row.phone as string) ?? '';
  }

  return {
    id: row.id as string,
    phone,
    sentContactId: row.sent_contact_id as string | null,
    name: name ? await decrypt(name, env.ENCRYPTION_KEY) : null,
    email: email ? await decrypt(email, env.ENCRYPTION_KEY) : null,
    subscriptionTier: row.subscription_tier as User['subscriptionTier'],
    stripeCustomerId: row.stripe_customer_id as string | null,
    currentRetailerId: row.current_retailer_id as string | null,
    currentPlanName: row.current_plan_name as string | null,
    icpNumber: icpNumber ? await decrypt(icpNumber, env.ENCRYPTION_KEY) : null,
    installationAddress: installationAddress
      ? await decrypt(installationAddress, env.ENCRYPTION_KEY)
      : null,
    notificationThresholdCents: row.notification_threshold_cents as number,
    state: row.state as ConversationState,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Create a new user. Encrypts PII fields before insert.
 * Dual-writes phone (legacy) + phone_encrypted + phone_hash for migration.
 */
export async function createUser(
  db: D1Database,
  env: EncryptionEnv,
  input: CreateUserInput
): Promise<User> {
  const id = generateId();
  const now = new Date().toISOString();

  const encryptedName = input.name
    ? await encrypt(input.name, env.ENCRYPTION_KEY)
    : null;
  const phoneEncrypted = await encrypt(input.phone, env.ENCRYPTION_KEY);
  const phoneHash = await generatePhoneHash(input.phone);

  const stmt = db.prepare(
    `INSERT INTO users (id, phone, phone_encrypted, phone_hash, sent_contact_id, name, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  );

  await stmt
    .bind(id, input.phone, phoneEncrypted, phoneHash, input.sentContactId ?? null, encryptedName, now, now)
    .run();

  const user = await getUserById(db, env, id);
  if (!user) throw new Error('Failed to create user');
  return user;
}

/**
 * Get a user by their primary key ID. Decrypts PII fields on read.
 */
export async function getUserById(
  db: D1Database,
  env: EncryptionEnv,
  id: string
): Promise<User | null> {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToUser(result, env);
}

/**
 * Get a user by phone number using the blind index (phone_hash).
 * Falls back to legacy plaintext phone column if hash column is null.
 */
export async function getUserByPhone(
  db: D1Database,
  env: EncryptionEnv,
  phone: string
): Promise<User | null> {
  const phoneHash = await generatePhoneHash(phone);

  // Try blind index first
  const stmt = db.prepare('SELECT * FROM users WHERE phone_hash = ?1');
  const result = await stmt.bind(phoneHash).first<Record<string, unknown>>();

  if (result) return rowToUser(result, env);

  // Fall back to legacy plaintext lookup for unmigrated rows
  const legacyStmt = db.prepare('SELECT * FROM users WHERE phone = ?1 AND phone_hash IS NULL');
  const legacyResult = await legacyStmt.bind(phone).first<Record<string, unknown>>();

  if (!legacyResult) return null;
  return rowToUser(legacyResult, env);
}

/**
 * Find an existing user by phone, or create a new one.
 * Returns the user (existing or new) and whether it was created.
 */
export async function findOrCreateByPhone(
  db: D1Database,
  env: EncryptionEnv,
  phone: string
): Promise<{ user: User; created: boolean }> {
  const existing = await getUserByPhone(db, env, phone);
  if (existing) return { user: existing, created: false };
  const user = await createUser(db, env, { phone });
  return { user, created: true };
}

/**
 * Update a user's fields. Encrypts PII fields before writing.
 * Only updates fields that are explicitly provided (undefined fields are ignored).
 */
export async function updateUser(
  db: D1Database,
  env: EncryptionEnv,
  id: string,
  input: UpdateUserInput
): Promise<User> {
  const existing = await getUserById(db, env, id);
  if (!existing) throw new Error(`User not found: ${id}`);

  const now = new Date().toISOString();

  // Build SET clauses dynamically based on provided fields
  const setClauses: string[] = [];
  const params: unknown[] = [];

  let paramIndex = 1;

  if (input.phone !== undefined) {
    const phoneEncrypted = await encrypt(input.phone, env.ENCRYPTION_KEY);
    const phoneHash = await generatePhoneHash(input.phone);
    setClauses.push(`phone = ?${paramIndex++}`);
    params.push(input.phone);
    setClauses.push(`phone_encrypted = ?${paramIndex++}`);
    params.push(phoneEncrypted);
    setClauses.push(`phone_hash = ?${paramIndex++}`);
    params.push(phoneHash);
  }
  if (input.sentContactId !== undefined) {
    setClauses.push(`sent_contact_id = ?${paramIndex++}`);
    params.push(input.sentContactId);
  }
  if (input.name !== undefined) {
    const encryptedName = input.name
      ? await encrypt(input.name, env.ENCRYPTION_KEY)
      : null;
    setClauses.push(`name = ?${paramIndex++}`);
    params.push(encryptedName);
  }
  if (input.email !== undefined) {
    const encryptedEmail = input.email
      ? await encrypt(input.email, env.ENCRYPTION_KEY)
      : null;
    setClauses.push(`email = ?${paramIndex++}`);
    params.push(encryptedEmail);
  }
  if (input.subscriptionTier !== undefined) {
    setClauses.push(`subscription_tier = ?${paramIndex++}`);
    params.push(input.subscriptionTier);
  }
  if (input.stripeCustomerId !== undefined) {
    setClauses.push(`stripe_customer_id = ?${paramIndex++}`);
    params.push(input.stripeCustomerId);
  }
  if (input.currentRetailerId !== undefined) {
    setClauses.push(`current_retailer_id = ?${paramIndex++}`);
    params.push(input.currentRetailerId);
  }
  if (input.currentPlanName !== undefined) {
    setClauses.push(`current_plan_name = ?${paramIndex++}`);
    params.push(input.currentPlanName);
  }
  if (input.icpNumber !== undefined) {
    const encryptedIcp = input.icpNumber
      ? await encrypt(input.icpNumber, env.ENCRYPTION_KEY)
      : null;
    setClauses.push(`icp_number = ?${paramIndex++}`);
    params.push(encryptedIcp);
  }
  if (input.installationAddress !== undefined) {
    const encryptedAddr = input.installationAddress
      ? await encrypt(input.installationAddress, env.ENCRYPTION_KEY)
      : null;
    setClauses.push(`installation_address = ?${paramIndex++}`);
    params.push(encryptedAddr);
  }
  if (input.notificationThresholdCents !== undefined) {
    setClauses.push(`notification_threshold_cents = ?${paramIndex++}`);
    params.push(input.notificationThresholdCents);
  }
  if (input.state !== undefined) {
    setClauses.push(`state = ?${paramIndex++}`);
    params.push(input.state);
  }

  // Always update updated_at
  setClauses.push(`updated_at = ?${paramIndex++}`);
  params.push(now);

  // Add the id as the final parameter
  params.push(id);

  const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?${paramIndex}`;
  const stmt = db.prepare(sql);
  await stmt.bind(...params).run();

  return getUserById(db, env, id) as Promise<User>;
}

/**
 * Update a user's conversation state only.
 * This is the hot-path update for the KV-backed state machine.
 */
export async function updateUserState(
  db: D1Database,
  id: string,
  state: ConversationState
): Promise<void> {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE users SET state = ?1, updated_at = ?2 WHERE id = ?3'
  );
  await stmt.bind(state, now, id).run();
}

/**
 * Delete a user by ID.
 */
export async function deleteUser(
  db: D1Database,
  id: string
): Promise<void> {
  const stmt = db.prepare('DELETE FROM users WHERE id = ?1');
  await stmt.bind(id).run();
}

/**
 * Issue #126 — read a user's configured notification threshold (cents).
 * Returns the per-user value, defaulting to DEFAULT_NOTIFICATION_THRESHOLD_CENTS
 * when the user or column is missing/unset.
 *
 * Reuses getUserById rather than issuing a dedicated query — the notifier
 * already needs the full user row (for phone) and the threshold is one column.
 */
export const DEFAULT_NOTIFICATION_THRESHOLD_CENTS = 5000;

export async function getNotificationThreshold(
  db: D1Database,
  env: EncryptionEnv,
  userId: string
): Promise<number> {
  const user = await getUserById(db, env, userId);
  if (!user) return DEFAULT_NOTIFICATION_THRESHOLD_CENTS;
  const threshold = user.notificationThresholdCents;
  // ponytail: guard against a non-positive / NaN value slipping through;
  // schema default is 5000 but defend at the boundary where we read it.
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return DEFAULT_NOTIFICATION_THRESHOLD_CENTS;
  }
  return threshold;
}

/**
 * Issue #75 — return just the IDs of users whose current retailer matches.
 * Used by the plan-diff consumer to find who to re-compare when a retailer's
 * plans change. Returns IDs only (no PII decryption needed; the caller only
 * enqueues `{ user_id }` to COMPARE_QUEUE).
 */
export async function getUsersByRetailer(
  db: D1Database,
  retailerId: string
): Promise<string[]> {
  const result = await db
    .prepare('SELECT id FROM users WHERE current_retailer_id = ?1')
    .bind(retailerId)
    .all<{ id: string }>();
  return (result.results ?? []).map(r => r.id);
}

/**
 * Issue #78 — return the IDs of all free-tier users. Used by the monthly
 * free-tier check-in cron to iterate the population that receives the
 * `free_tier_checkin` status notification. Returns IDs only (no PII
 * decryption needed; the caller re-fetches per-user context when sending).
 * ponytail: same shape as getUsersByRetailer — IDs only, single column.
 */
export async function getFreeTierUsers(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare('SELECT id FROM users WHERE subscription_tier = ?1')
    .bind('free')
    .all<{ id: string }>();
  return (result.results ?? []).map(r => r.id);
}
