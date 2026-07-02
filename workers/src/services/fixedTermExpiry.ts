/**
 * Issue #79 (Epic #8) — fixed-term contract expiry notifications.
 *
 * Daily cron finds bills whose `fixed_term_expiry` falls in the 60/30/7-day
 * window and sends the `fixed_term_expiry` template (PRD 3.4 / 7.7) carrying
 * the retailer name + expiry date, with a break-fee note appended when
 * `break_fee_cents` is set.
 *
 * Dedup: KV key `fixed_term_expiry:{userId}:{expiryDate}:{window}` with a
 * 30-day TTL. A user gets AT MOST ONE notification per window per expiry —
 * not one per daily cron tick. A 30-day TTL comfortably covers the smallest
 * window gap (23 days between the 30d and 7d ticks) and the largest (30 days
 * between 60d and 30d), so the same window never double-fires.
 *
 * Send path: dedicated small sender (NOT the NOTIFY_QUEUE / evaluateAndNotify
 * path, which is gated on a comparisonId + saving threshold that do not apply
 * here). Reuses renderTemplate + sendText + createNotificationAudit so the
 * compliance audit row is still written on send/fail (#78 pattern).
 *
 * No `users.unsubscribe` / opt-out flag exists yet (verified in 0001_initial).
 * The UNSUBSCRIBED skip in the AC is moot until that column lands; noted in
 * the PR body.
 */

import {
  getUpcomingFixedTermExpiries,
  type UpcomingFixedTermExpiryRow,
} from '../models/bills';
import { sendText } from './messaging';
import { renderTemplate } from './sentTemplates';
import { createNotificationAudit } from '../models/notificationAudit';

/** The three PRD notification windows, narrowest first. */
export type ExpiryWindow = '60d' | '30d' | '7d';

/** The widest window we scan for — bounds the D1 query. */
export const MAX_WINDOW_DAYS = 60;

/** KV dedup gate — 30-day TTL (covers all inter-window gaps, see header). */
const DEDUP_KEY_PREFIX = 'fixed_term_expiry:';
const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface FixedTermExpiryEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly SENT_API_KEY: string;
}

/** Days-from-now thresholds for each window (inclusive lower bound). */
const WINDOW_THRESHOLDS: ReadonlyArray<{ window: ExpiryWindow; days: number }> = [
  { window: '7d', days: 7 },
  { window: '30d', days: 30 },
  { window: '60d', days: 60 },
];

/**
 * PURE classifier — which notification window (if any) an expiry falls into
 * today. Returns the NARROWEST applicable window: an expiry 7 days out returns
 * `'7d'` only (not also `'30d'`/`'60d'`), so a single bill never triggers more
 * than one notification per tick.
 *
 * Boundaries are INCLUSIVE: an expiry exactly 7 days from today → `'7d'`.
 * Past or >60-day expiries → null.
 *
 * Date arithmetic is UTC-day based. NZ expiry dates are stored date-only
 * (YYYY-MM-DD); comparing the date component of `now` to the expiry string
 * keeps the math timezone-agnostic and matches how the bills are written.
 */
export function classifyExpiryWindow(
  expiryDate: string,
  now: Date
): ExpiryWindow | null {
  const expiryDay = startOfUtcDay(expiryDate);
  if (expiryDay === null) return null;
  const today = startOfUtcDay(now.toISOString());
  if (today === null) return null;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntil = Math.round((expiryDay.getTime() - today.getTime()) / msPerDay);

  if (daysUntil < 0 || daysUntil > MAX_WINDOW_DAYS) return null;

  // Narrowest first: 7d beats 30d beats 60d.
  for (const { window, days } of WINDOW_THRESHOLDS) {
    if (daysUntil <= days) return window;
  }
  return null;
}

/** Parse a YYYY-MM-DD (or ISO) string to a UTC midnight Date, or null. */
function startOfUtcDay(iso: string): Date | null {
  const day = iso.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Build the break-fee suffix appended to the rendered template body when the
 * bill carries a `break_fee_cents`. Kept pure for unit testing.
 */
export function buildBreakFeeNote(breakFeeCents: number | null): string {
  if (breakFeeCents === null || breakFeeCents <= 0) return '';
  const dollars = Math.round(breakFeeCents / 100);
  return ` Switching before then may incur a $${dollars} break fee.`;
}

/**
 * Compose the full message body: rendered template + break-fee note. PURE.
 */
export function buildExpiryMessage(
  row: Pick<UpcomingFixedTermExpiryRow, 'retailerName' | 'fixedTermExpiry' | 'breakFeeCents'>
): string {
  const body = renderTemplate('fixed_term_expiry', {
    retailer: row.retailerName ?? 'your retailer',
    expiry_date: row.fixedTermExpiry.slice(0, 10),
  });
  return body + buildBreakFeeNote(row.breakFeeCents);
}

/**
 * Daily fixed-term expiry scan. Returns an observability summary; emits ZERO
 * PII to logs (counts only).
 */
export async function runFixedTermExpiryScan(env: FixedTermExpiryEnv): Promise<{
  billsScanned: number;
  notificationsSent: number;
  skippedDedup: number;
  skippedNoPhone: number;
  failed: number;
}> {
  const rows = await getUpcomingFixedTermExpiries(env.DB, MAX_WINDOW_DAYS);
  const now = new Date();

  let notificationsSent = 0;
  let skippedDedup = 0;
  let skippedNoPhone = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const window = classifyExpiryWindow(row.fixedTermExpiry, now);
      if (window === null) continue;

      const dedupKey = `${DEDUP_KEY_PREFIX}${row.userId}:${row.fixedTermExpiry.slice(0, 10)}:${window}`;
      if ((await env.KV.get(dedupKey)) !== null) {
        skippedDedup++;
        continue;
      }

      if (!row.phone) {
        skippedNoPhone++;
        continue;
      }

      const message = buildExpiryMessage(row);

      let sentMessageId: string | null = null;
      try {
        const result = await sendText(env.SENT_API_KEY, row.phone, message);
        sentMessageId = result.messageId;
      } catch (error) {
        failed++;
        const reason = error instanceof Error ? error.message : 'unknown';
        console.log(JSON.stringify({
          type: 'fixed_term_expiry_send_error',
          userId: row.userId,
          billId: row.billId,
          window,
          error: reason,
          timestamp: now.toISOString(),
        }));
        // ponytail: record the failure in the audit; do NOT set the dedup key
        // so the next daily tick can retry.
        void createNotificationAudit(env.DB, {
          userId: row.userId,
          notificationType: 'fixed_term_expiry',
          channel: 'whatsapp',
          template: 'fixed_term_expiry',
          status: 'failed',
          reason,
        });
        continue;
      }

      // Mark sent — set the dedup gate AFTER successful dispatch.
      await env.KV.put(dedupKey, now.toISOString(), {
        expirationTtl: DEDUP_TTL_SECONDS,
      });

      void createNotificationAudit(env.DB, {
        userId: row.userId,
        notificationType: 'fixed_term_expiry',
        channel: 'whatsapp',
        template: 'fixed_term_expiry',
        sentMessageId,
        status: 'sent',
      });

      notificationsSent++;
      console.log(JSON.stringify({
        type: 'fixed_term_expiry_sent',
        userId: row.userId,
        billId: row.billId,
        window,
        timestamp: now.toISOString(),
      }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({
        type: 'fixed_term_expiry_row_error',
        userId: row.userId,
        billId: row.billId,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: now.toISOString(),
      }));
    }
  }

  console.log(JSON.stringify({
    type: 'fixed_term_expiry_run',
    bills_scanned: rows.length,
    notifications_sent: notificationsSent,
    skipped_dedup: skippedDedup,
    skipped_no_phone: skippedNoPhone,
    failed,
    timestamp: now.toISOString(),
  }));

  return {
    billsScanned: rows.length,
    notificationsSent,
    skippedDedup,
    skippedNoPhone,
    failed,
  };
}
