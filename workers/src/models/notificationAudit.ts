/**
 * Issue #82 (Epic #8) — compliance audit log for every notification outcome.
 *
 * One row per notification outcome (sent / suppressed / failed) across
 * WhatsApp, SMS, and email. Separate from the `notifications` table (0001),
 * which tracks user RESPONSES; this table tracks the compliance audit trail
 * ("who was notified about what, when, via which channel, and did it land?").
 *
 * 90-day retention via purgeNotificationAudit, run from the daily 03:00 UTC
 * cron slot (reused with the LLM-audit purge to avoid growing the cron list).
 */
import type { NotificationType } from '../types/notification';

/** Channels a notification can be delivered through (matches migration CHECK). */
export type NotificationChannel = 'whatsapp' | 'sms' | 'email';

/** Outcome of a notification attempt (matches migration status CHECK). */
export type NotificationAuditStatus = 'sent' | 'suppressed' | 'failed';

/** Row shape for notification_audit (snake_case from D1). */
export interface NotificationAuditRow {
  readonly id: string;
  readonly userId: string;
  readonly notificationType: NotificationType;
  readonly comparisonId: string | null;
  readonly channel: NotificationChannel;
  readonly template: string | null;
  readonly sentMessageId: string | null;
  readonly status: NotificationAuditStatus;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** Input for createNotificationAudit. Optional fields default to null. */
export interface CreateNotificationAuditInput {
  readonly userId: string;
  readonly notificationType: NotificationType;
  readonly comparisonId?: string | null;
  readonly channel: NotificationChannel;
  readonly template?: string | null;
  readonly sentMessageId?: string | null;
  readonly status: NotificationAuditStatus;
  readonly reason?: string | null;
}

/** Query options for listNotificationAudit (admin history endpoint). */
export interface ListNotificationAuditOptions {
  readonly userId?: string;
  readonly status?: NotificationAuditStatus;
  readonly since?: string; // ISO 8601 — filters created_at >= since
  readonly limit?: number;
  readonly offset?: number;
}

function generateId(): string {
  return crypto.randomUUID();
}

function rowToAudit(row: Record<string, unknown>): NotificationAuditRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    notificationType: row.notification_type as NotificationType,
    comparisonId: (row.comparison_id as string | null | undefined) ?? null,
    channel: row.channel as NotificationChannel,
    template: (row.template as string | null | undefined) ?? null,
    sentMessageId: (row.sent_message_id as string | null | undefined) ?? null,
    status: row.status as NotificationAuditStatus,
    reason: (row.reason as string | null | undefined) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * Persist one audit row per notification outcome. Returns the row id.
 * Callers are the notification send path (one row per attempted send) and the
 * suppression path (one row per suppressed notification with reason set).
 */
export async function createNotificationAudit(
  db: D1Database,
  input: CreateNotificationAuditInput
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO notification_audit (
        id, user_id, notification_type, comparison_id,
        channel, template, sent_message_id,
        status, reason, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      id,
      input.userId,
      input.notificationType,
      input.comparisonId ?? null,
      input.channel,
      input.template ?? null,
      input.sentMessageId ?? null,
      input.status,
      input.reason ?? null,
      now
    )
    .run();

  return id;
}

/**
 * Paginated audit history for the admin endpoint. Filters by user_id, status,
 * and a since-date; ordered newest-first. Mirrors the D1 bind-by-position
 * pattern used by comparisons.ts.
 */
export async function listNotificationAudit(
  db: D1Database,
  options: ListNotificationAuditOptions = {}
): Promise<readonly NotificationAuditRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  // ponytail: build WHERE clause + params dynamically — no query builder
  // needed (4 optional filters max, plain string accumulation is clearer than
  // an abstraction for a single call site).
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.userId) {
    params.push(options.userId);
    where.push(`user_id = ?${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    where.push(`status = ?${params.length}`);
  }
  if (options.since) {
    params.push(options.since);
    where.push(`created_at >= ?${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const stmt = db.prepare(
    `SELECT * FROM notification_audit ${whereSql} ORDER BY created_at DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
  );
  const result = await stmt.bind(...params).all<Record<string, unknown>>();

  return result.results?.map(rowToAudit) ?? [];
}

/**
 * Delete audit rows older than `retentionDays`. Returns the count deleted.
 * AC #82 default retention is 90 days; called from the daily 03:00 UTC cron.
 */
export async function purgeNotificationAudit(
  db: D1Database,
  retentionDays = 90
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM notification_audit WHERE created_at < datetime('now', ?1)`
    )
    .bind(`-${retentionDays} days`)
    .run();
  return (result.meta?.changes ?? 0) as number;
}
