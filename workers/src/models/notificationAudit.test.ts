import { describe, it, expect } from 'vitest';
import {
  createNotificationAudit,
  listNotificationAudit,
  purgeNotificationAudit,
} from './notificationAudit';

/**
 * Issue #82 — D1 model tests. Mirrors the fakeDB pattern from users.test.ts
 * (bind-by-position capturing the SQL + params).
 */

interface Bound {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeDB(opts: {
  readonly allRows?: readonly Record<string, unknown>[];
  readonly changes?: number;
} = {}): { db: D1Database; captured: Bound[] } {
  const captured: Bound[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        captured.push({ sql, params });
        return {
          all: async <T>() => ({
            results: (opts.allRows ?? []) as unknown as T[],
            success: true,
            meta: {},
          }),
          first: async <T>() => null as T | null,
          run: async () => ({ success: true, meta: { changes: opts.changes ?? 1 } }),
        };
      },
    }),
  } as unknown as D1Database;
  return { db, captured };
}

describe('createNotificationAudit (issue #82)', () => {
  it('inserts a sent row with all fields and returns an id', async () => {
    const { db, captured } = fakeDB();
    const id = await createNotificationAudit(db, {
      userId: 'u-1',
      notificationType: 'saving_alert',
      comparisonId: 'cmp-9',
      channel: 'whatsapp',
      template: 'saving_alert',
      sentMessageId: 'sent-msg-1',
      status: 'sent',
    });

    expect(id).toEqual(expect.any(String));
    expect(captured).toHaveLength(1);
    const stmt = captured[0]!;
    expect(stmt.sql).toContain('INSERT INTO notification_audit');
    // user_id, notification_type, comparison_id, channel, template,
    // sent_message_id, status, reason, created_at → 10 bound values (incl. id)
    expect(stmt.params[0]).toBe(id);
    expect(stmt.params[1]).toBe('u-1');
    expect(stmt.params[2]).toBe('saving_alert');
    expect(stmt.params[3]).toBe('cmp-9');
    expect(stmt.params[4]).toBe('whatsapp');
    expect(stmt.params[5]).toBe('saving_alert');
    expect(stmt.params[6]).toBe('sent-msg-1');
    expect(stmt.params[7]).toBe('sent');
    // reason defaults to null on a clean sent row
    expect(stmt.params[8]).toBeNull();
  });

  it('inserts a suppressed row with reason set, comparison_id null', async () => {
    const { db, captured } = fakeDB();
    await createNotificationAudit(db, {
      userId: 'u-2',
      notificationType: 'stay_put',
      channel: 'sms',
      status: 'suppressed',
      reason: 'user unsubscribed',
    });

    const stmt = captured[0]!;
    expect(stmt.params[3]).toBeNull(); // comparison_id defaults to null
    expect(stmt.params[7]).toBe('suppressed');
    expect(stmt.params[8]).toBe('user unsubscribed');
  });

  it('inserts a failed row with reason and null sent_message_id', async () => {
    const { db, captured } = fakeDB();
    await createNotificationAudit(db, {
      userId: 'u-3',
      notificationType: 'switch_update',
      channel: 'whatsapp',
      status: 'failed',
      reason: 'provider 5xx',
    });

    const stmt = captured[0]!;
    expect(stmt.params[6]).toBeNull(); // sent_message_id null on failed
    expect(stmt.params[8]).toBe('provider 5xx');
  });
});

describe('listNotificationAudit (issue #82)', () => {
  it('returns rows newest-first and applies default limit/offset', async () => {
    const rows = [
      { id: 'a1', user_id: 'u-1', notification_type: 'saving_alert', created_at: '2026-07-02' },
      { id: 'a2', user_id: 'u-1', notification_type: 'stay_put', created_at: '2026-07-01' },
    ];
    const { db, captured } = fakeDB({ allRows: rows });

    const result = await listNotificationAudit(db, {});

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('a1');
    const stmt = captured[0]!;
    expect(stmt.sql).toContain('ORDER BY created_at DESC');
    expect(stmt.sql).toContain('LIMIT');
    expect(stmt.sql).toContain('OFFSET');
  });

  it('filters by user_id, status, and since via WHERE clause + bound params', async () => {
    const { db, captured } = fakeDB({ allRows: [] });

    await listNotificationAudit(db, {
      userId: 'u-9',
      status: 'failed',
      since: '2026-06-01',
      limit: 10,
      offset: 5,
    });

    const stmt = captured[0]!;
    expect(stmt.sql).toContain('WHERE');
    expect(stmt.sql).toContain('user_id =');
    expect(stmt.sql).toContain('status =');
    expect(stmt.sql).toContain('created_at >=');
    // first 3 params are the filters
    expect(stmt.params.slice(0, 3)).toEqual(['u-9', 'failed', '2026-06-01']);
    // last 2 are limit + offset
    expect(stmt.params[stmt.params.length - 2]).toBe(10);
    expect(stmt.params[stmt.params.length - 1]).toBe(5);
  });

  it('clamps limit to [1, 200] and offset to >= 0', async () => {
    const { db, captured } = fakeDB({ allRows: [] });

    await listNotificationAudit(db, { limit: 9999, offset: -50 });
    const stmt = captured[0]!;
    expect(stmt.params[stmt.params.length - 2]).toBe(200); // clamped limit
    expect(stmt.params[stmt.params.length - 1]).toBe(0); // clamped offset
  });
});

describe('purgeNotificationAudit (issue #82)', () => {
  it('issues a DELETE older than retention days and returns the change count', async () => {
    const { db, captured } = fakeDB({ changes: 42 });

    const deleted = await purgeNotificationAudit(db, 90);

    expect(deleted).toBe(42);
    const stmt = captured[0]!;
    expect(stmt.sql).toContain('DELETE FROM notification_audit');
    expect(stmt.sql).toContain("datetime('now', ?1)");
    expect(stmt.params[0]).toBe('-90 days');
  });

  it('defaults to 90 days when no retention passed', async () => {
    const { db, captured } = fakeDB();

    await purgeNotificationAudit(db);

    expect(captured[0]!.params[0]).toBe('-90 days');
  });
});
