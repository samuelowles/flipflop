import type { Message, MessageDirection, MessageChannel } from '../types/message';
import type { Intent } from '../types/conversation';
import type { EncryptionEnv } from './encryption';
import { encrypt, decrypt } from './encryption';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    direction: row.direction as MessageDirection,
    channel: row.channel as MessageChannel,
    body: (row.body_encrypted as string | null) ?? (row.body as string | null),
    mediaUrl: row.media_url as string | null,
    sentMessageId: row.sent_message_id as string | null,
    intent: row.intent as Intent | null,
    createdAt: row.created_at as string,
  };
}

/**
 * Create a new message record.
 * Encrypts the body before insert. Stores plaintext in legacy body column
 * and encrypted in body_encrypted as a dual-write migration pattern.
 */
export async function createMessage(
  db: D1Database,
  env: EncryptionEnv,
  input: {
    readonly userId: string;
    readonly direction: MessageDirection;
    readonly channel: MessageChannel;
    readonly body?: string | null;
    readonly mediaUrl?: string | null;
    readonly sentMessageId?: string | null;
    readonly intent?: Intent | null;
  }
): Promise<Message> {
  const id = generateId();
  const now = new Date().toISOString();

  const bodyEncrypted = input.body
    ? await encrypt(input.body, env.ENCRYPTION_KEY)
    : null;

  const stmt = db.prepare(
    `INSERT INTO messages (id, user_id, direction, channel, body, body_encrypted, media_url, sent_message_id, intent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  );

  await stmt
    .bind(
      id,
      input.userId,
      input.direction,
      input.channel,
      input.body ?? null,
      bodyEncrypted,
      input.mediaUrl ?? null,
      input.sentMessageId ?? null,
      input.intent ?? null,
      now
    )
    .run();

  const message = await getMessageById(db, id);
  if (!message) throw new Error('Failed to create message');
  return message;
}

/**
 * Get a message by its primary key ID (internal helper, not exported).
 */
async function getMessageById(
  db: D1Database,
  id: string
): Promise<Message | null> {
  const stmt = db.prepare('SELECT * FROM messages WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToMessage(result);
}

/**
 * Get all messages for a user, ordered by creation date descending.
 */
export async function getMessagesByUserId(
  db: D1Database,
  userId: string,
  limit = 50
): Promise<readonly Message[]> {
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2'
  );
  const results = await stmt.bind(userId, limit).all<Record<string, unknown>>();

  return results.results?.map(rowToMessage) ?? [];
}

/**
 * Get messages for a user since a given ISO 8601 timestamp.
 * Used for context window retrieval in the conversation state machine.
 */
export async function getMessagesByUserIdSince(
  db: D1Database,
  userId: string,
  since: string,
  limit = 20
): Promise<readonly Message[]> {
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE user_id = ?1 AND created_at > ?2 ORDER BY created_at ASC LIMIT ?3'
  );
  const results = await stmt.bind(userId, since, limit).all<Record<string, unknown>>();

  return results.results?.map(rowToMessage) ?? [];
}
