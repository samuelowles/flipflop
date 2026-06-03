import type { OAuthToken, OAuthProvider } from '../types/oauth';
import type { EncryptionEnv } from './encryption';
import { encrypt } from './encryption';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToOAuthToken(row: Record<string, unknown>): OAuthToken {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    provider: row.provider as OAuthProvider,
    accessTokenEncrypted: row.access_token_encrypted as string,
    refreshTokenEncrypted: row.refresh_token_encrypted as string | null,
    expiry: row.expiry as string,
    createdAt: row.created_at as string,
  };
}

/**
 * Store OAuth tokens for a user and provider.
 * Accepts PLAINTEXT tokens and encrypts them internally.
 * If tokens already exist for this user + provider, update them.
 */
export async function storeOAuthTokens(
  db: D1Database,
  env: EncryptionEnv,
  input: {
    readonly userId: string;
    readonly provider: OAuthProvider;
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly expiry: string;
  }
): Promise<OAuthToken> {
  const accessTokenEncrypted = await encrypt(input.accessToken, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = input.refreshToken
    ? await encrypt(input.refreshToken, env.ENCRYPTION_KEY)
    : null;

  // Check if tokens already exist for this user + provider
  const existing = db.prepare(
    'SELECT id FROM oauth_tokens WHERE user_id = ?1 AND provider = ?2'
  );
  const existingRow = await existing
    .bind(input.userId, input.provider)
    .first<{ id: string } | null>();

  if (existingRow) {
    // Update existing tokens
    const stmt = db.prepare(
      `UPDATE oauth_tokens
       SET access_token_encrypted = ?1, refresh_token_encrypted = ?2, expiry = ?3
       WHERE id = ?4`
    );

    await stmt
      .bind(
        accessTokenEncrypted,
        refreshTokenEncrypted,
        input.expiry,
        existingRow.id
      )
      .run();

    const token = await getOAuthTokenById(db, existingRow.id);
    if (!token) throw new Error('Failed to update OAuth tokens');
    return token;
  }

  // Insert new tokens
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, access_token_encrypted, refresh_token_encrypted, expiry, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  );

  await stmt
    .bind(
      id,
      input.userId,
      input.provider,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      input.expiry,
      now
    )
    .run();

  const token = await getOAuthTokenById(db, id);
  if (!token) throw new Error('Failed to store OAuth tokens');
  return token;
}

/**
 * Get OAuth token by its primary key ID (internal helper, not exported).
 */
async function getOAuthTokenById(
  db: D1Database,
  id: string
): Promise<OAuthToken | null> {
  const stmt = db.prepare('SELECT * FROM oauth_tokens WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToOAuthToken(result);
}

/**
 * Get OAuth tokens for a user and provider.
 */
export async function getOAuthTokens(
  db: D1Database,
  userId: string,
  provider: OAuthProvider
): Promise<OAuthToken | null> {
  const stmt = db.prepare(
    'SELECT * FROM oauth_tokens WHERE user_id = ?1 AND provider = ?2'
  );
  const result = await stmt.bind(userId, provider).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToOAuthToken(result);
}

/**
 * Delete OAuth tokens for a user and provider (e.g., on disconnect).
 */
export async function deleteOAuthTokens(
  db: D1Database,
  userId: string,
  provider: OAuthProvider
): Promise<void> {
  const stmt = db.prepare(
    'DELETE FROM oauth_tokens WHERE user_id = ?1 AND provider = ?2'
  );
  await stmt.bind(userId, provider).run();
}
