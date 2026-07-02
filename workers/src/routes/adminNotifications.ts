/**
 * Admin endpoint for the notification audit trail (issue #82, Epic #8).
 *
 * GET /admin/notifications — paginated compliance history of every notification
 * outcome (sent / suppressed / failed). Filters: user_id, status, since (ISO
 * 8601 date). Used for the compliance audit (epic #11) and ops debugging.
 *
 * Auth: gated by the shared `adminAuth` middleware applied to `/admin/*` in
 * index.ts (requires `Authorization: Bearer <ADMIN_API_KEY>`). This closes the
 * Epic #3 SECURITY carry-over — no unauthenticated admin surface here.
 */
import type { Context } from 'hono';
import {
  listNotificationAudit,
  type NotificationAuditRow,
  type NotificationAuditStatus,
} from '../models/notificationAudit';

interface AdminNotificationsEnv {
  readonly DB: D1Database;
}

interface AuditResponse {
  readonly notifications: readonly NotificationAuditRow[];
  readonly limit: number;
  readonly offset: number;
  readonly filters: {
    readonly userId?: string;
    readonly status?: NotificationAuditStatus;
    readonly since?: string;
  };
}

const VALID_STATUSES = new Set<string>(['sent', 'suppressed', 'failed']);

export async function adminListNotifications(c: Context): Promise<Response> {
  const env = c.env as AdminNotificationsEnv;

  const userId = c.req.query('user_id') || undefined;
  const statusParam = c.req.query('status');
  const since = c.req.query('since') || undefined;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : 0;

  // Validate status if provided — reject unknown values rather than silently
  // returning an empty result (helps admins catch typos).
  let status: NotificationAuditStatus | undefined;
  if (statusParam) {
    if (!VALID_STATUSES.has(statusParam)) {
      return c.json(
        {
          error: `Invalid status '${statusParam}'. Must be one of: sent, suppressed, failed`,
          code: 'bad_request',
          status: 400,
        },
        400
      );
    }
    status = statusParam as NotificationAuditStatus;
  }

  if (Number.isNaN(limit) || Number.isNaN(offset)) {
    return c.json(
      { error: 'limit and offset must be integers', code: 'bad_request', status: 400 },
      400
    );
  }

  const notifications = await listNotificationAudit(env.DB, {
    userId,
    status,
    since,
    limit,
    offset,
  });

  const body: AuditResponse = {
    notifications,
    limit,
    offset,
    filters: {
      ...(userId ? { userId } : {}),
      ...(status ? { status } : {}),
      ...(since ? { since } : {}),
    },
  };

  return c.json(body);
}
