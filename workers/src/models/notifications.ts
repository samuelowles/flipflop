import type { Notification, NotificationType } from '../types/notification';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as NotificationType,
    contentJson: row.content_json as string | null,
    sentAt: row.sent_at as string,
    respondedAt: row.responded_at as string | null,
    response: row.response as string | null,
  };
}

/**
 * Create a new notification record.
 */
export async function createNotification(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly type: NotificationType;
    readonly contentJson?: string | null;
  }
): Promise<Notification> {
  const id = generateId();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO notifications (id, user_id, type, content_json, sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  );

  await stmt
    .bind(id, input.userId, input.type, input.contentJson ?? null, now)
    .run();

  const notification = await getNotificationById(db, id);
  if (!notification) throw new Error('Failed to create notification');
  return notification;
}

/**
 * Get a notification by its primary key ID (internal helper, not exported).
 */
async function getNotificationById(
  db: D1Database,
  id: string
): Promise<Notification | null> {
  const stmt = db.prepare('SELECT * FROM notifications WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToNotification(result);
}

/**
 * Get all notifications for a user, ordered by sent_at descending.
 */
export async function getNotificationsByUserId(
  db: D1Database,
  userId: string,
  limit = 20
): Promise<readonly Notification[]> {
  const stmt = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ?1 ORDER BY sent_at DESC LIMIT ?2'
  );
  const results = await stmt.bind(userId, limit).all<Record<string, unknown>>();

  return results.results?.map(rowToNotification) ?? [];
}

/**
 * Update a notification with a user response.
 */
export async function updateNotificationResponse(
  db: D1Database,
  id: string,
  response: string
): Promise<void> {
  const now = new Date().toISOString();

  const stmt = db.prepare(
    'UPDATE notifications SET response = ?1, responded_at = ?2 WHERE id = ?3'
  );
  await stmt.bind(response, now, id).run();
}

/**
 * Get the most recent notification for a user by type.
 */
export async function getLatestNotificationForUser(
  db: D1Database,
  userId: string,
  type?: NotificationType
): Promise<Notification | null> {
  let sql: string;
  let params: unknown[];

  if (type) {
    sql = 'SELECT * FROM notifications WHERE user_id = ?1 AND type = ?2 ORDER BY sent_at DESC LIMIT 1';
    params = [userId, type];
  } else {
    sql = 'SELECT * FROM notifications WHERE user_id = ?1 ORDER BY sent_at DESC LIMIT 1';
    params = [userId];
  }

  const stmt = db.prepare(sql);
  const result = await stmt.bind(...params).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToNotification(result);
}
