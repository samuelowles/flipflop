import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyExpiryWindow,
  buildBreakFeeNote,
  buildExpiryMessage,
  runFixedTermExpiryScan,
  type ExpiryWindow,
} from './fixedTermExpiry';
import type { UpcomingFixedTermExpiryRow } from '../models/bills';

/**
 * Issue #79 — fixed-term expiry notification tests.
 *
 * Two groups:
 *  1. classifyExpiryWindow / buildBreakFeeNote / buildExpiryMessage — PURE,
 *     all windows + boundaries + out-of-window + break-fee variants.
 *  2. runFixedTermExpiryScan — integration with mocked D1/KV/Sent, mirroring
 *     freeTierCheckin.test.ts's fake-KV/DB pattern.
 */

const NOW = new Date('2026-07-01T08:00:00Z');
const TODAY = '2026-07-01';

function daysFromToday(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// PURE: classifyExpiryWindow
// ---------------------------------------------------------------------------

describe('classifyExpiryWindow (issue #79) — pure window mapping', () => {
  it('returns 7d for an expiry exactly 7 days out (inclusive boundary)', () => {
    expect(classifyExpiryWindow(daysFromToday(7), NOW)).toBe('7d');
  });

  it('returns 30d for an expiry exactly 30 days out (inclusive boundary)', () => {
    expect(classifyExpiryWindow(daysFromToday(30), NOW)).toBe('30d');
  });

  it('returns 60d for an expiry exactly 60 days out (inclusive boundary)', () => {
    expect(classifyExpiryWindow(daysFromToday(60), NOW)).toBe('60d');
  });

  it('returns 7d for an expiry less than 7 days out (e.g. 3 days)', () => {
    expect(classifyExpiryWindow(daysFromToday(3), NOW)).toBe('7d');
  });

  it('returns 7d for an expiry today (0 days, edge case)', () => {
    expect(classifyExpiryWindow(TODAY, NOW)).toBe('7d');
  });

  it('returns 30d for an expiry between 8 and 30 days out', () => {
    expect(classifyExpiryWindow(daysFromToday(15), NOW)).toBe('30d');
  });

  it('returns 60d for an expiry between 31 and 60 days out', () => {
    expect(classifyExpiryWindow(daysFromToday(45), NOW)).toBe('60d');
  });

  it('returns null for an expiry more than 60 days out', () => {
    expect(classifyExpiryWindow(daysFromToday(61), NOW)).toBeNull();
    expect(classifyExpiryWindow(daysFromToday(90), NOW)).toBeNull();
  });

  it('returns null for a past expiry', () => {
    expect(classifyExpiryWindow(daysFromToday(-1), NOW)).toBeNull();
    expect(classifyExpiryWindow('2020-01-01', NOW)).toBeNull();
  });

  it('returns null for an unparseable date string', () => {
    expect(classifyExpiryWindow('not-a-date', NOW)).toBeNull();
  });

  it('uses the narrowest applicable window — 7d does not also return 30d', () => {
    // 5 days out could match 7d, 30d, 60d thresholds — must pick 7d only.
    const w = classifyExpiryWindow(daysFromToday(5), NOW) as ExpiryWindow;
    expect(w).toBe('7d');
  });

  it('handles full ISO datetime expiry strings by slicing to the date', () => {
    const iso = `${daysFromToday(30)}T23:59:59Z`;
    expect(classifyExpiryWindow(iso, NOW)).toBe('30d');
  });
});

// ---------------------------------------------------------------------------
// PURE: buildBreakFeeNote + buildExpiryMessage
// ---------------------------------------------------------------------------

describe('buildBreakFeeNote (issue #79)', () => {
  it('returns empty string when break_fee_cents is null', () => {
    expect(buildBreakFeeNote(null)).toBe('');
  });

  it('returns empty string when break_fee_cents is zero', () => {
    expect(buildBreakFeeNote(0)).toBe('');
  });

  it('returns empty string when break_fee_cents is negative', () => {
    expect(buildBreakFeeNote(-500)).toBe('');
  });

  it('renders the dollar amount rounded to the nearest whole dollar', () => {
    expect(buildBreakFeeNote(15000)).toContain('$150');
    expect(buildBreakFeeNote(12500)).toContain('$125'); // rounds 125.00 → 125
  });

  it('includes the break-fee warning text', () => {
    const note = buildBreakFeeNote(20000);
    expect(note).toMatch(/break fee/i);
  });
});

describe('buildExpiryMessage (issue #79)', () => {
  function baseRow(
    overrides: Partial<UpcomingFixedTermExpiryRow> = {}
  ): UpcomingFixedTermExpiryRow {
    return {
      billId: 'b-1',
      userId: 'u-1',
      phone: '+6421555000',
      fixedTermExpiry: '2026-08-01',
      breakFeeCents: null,
      retailerName: 'Meridian',
      ...overrides,
    };
  }

  it('renders the retailer name and expiry date', () => {
    const msg = buildExpiryMessage(baseRow());
    expect(msg).toContain('Meridian');
    expect(msg).toContain('2026-08-01');
  });

  it('falls back to "your retailer" when retailerName is null', () => {
    const msg = buildExpiryMessage(baseRow({ retailerName: null }));
    expect(msg).toContain('your retailer');
  });

  it('appends the break-fee note when break_fee_cents is set', () => {
    const msg = buildExpiryMessage(baseRow({ breakFeeCents: 15000 }));
    expect(msg).toContain('$150');
    expect(msg).toMatch(/break fee/i);
  });

  it('omits the break-fee note when break_fee_cents is null', () => {
    const msg = buildExpiryMessage(baseRow({ breakFeeCents: null }));
    expect(msg).not.toMatch(/break fee/i);
  });

  it('slices a full ISO expiry to YYYY-MM-DD', () => {
    const msg = buildExpiryMessage(baseRow({ fixedTermExpiry: '2026-08-01T12:00:00Z' }));
    expect(msg).toContain('2026-08-01');
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: runFixedTermExpiryScan — mocked D1/KV/Sent.
// ---------------------------------------------------------------------------

function createFakeKV(
  store: Map<string, { value: string; expiresAt?: number }> = new Map()
): KVNamespace {
  const kv = store;
  const now = () => Date.now();
  return {
    get: async (key: string) => {
      const entry = kv.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < now()) {
        kv.delete(key);
        return null;
      }
      return entry.value;
    },
    list: async () => ({ keys: [], list_complete: true }),
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiresAt = opts?.expirationTtl !== undefined ? now() + opts.expirationTtl * 1000 : undefined;
      kv.set(key, { value, expiresAt });
    },
    delete: async (key: string) => { kv.delete(key); },
  } as unknown as KVNamespace;
}

interface ExpiryRow {
  readonly bill_id: string;
  readonly user_id: string;
  readonly phone: string | null;
  readonly fixed_term_expiry: string;
  readonly break_fee_cents: number | null;
  readonly retailer_name: string | null;
}

function createFakeDB(rows: ExpiryRow[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => {
        // getUpcomingFixedTermExpiries
        if (sql.includes('fixed_term_expiry IS NOT NULL')) {
          return {
            all: async () => ({ results: rows, success: true, meta: {} }),
            first: async () => null,
            run: async () => ({ success: true, meta: {} }),
          };
        }
        // createNotificationAudit INSERT
        return {
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => ({ success: true, meta: {} }),
        };
      },
    }),
  } as unknown as D1Database;
}

function makeRow(overrides: Partial<ExpiryRow> = {}): ExpiryRow {
  return {
    bill_id: 'b-1',
    user_id: 'u-1',
    phone: '+6421555000',
    fixed_term_expiry: daysFromToday(30),
    break_fee_cents: null,
    retailer_name: 'Meridian',
    ...overrides,
  };
}

describe('runFixedTermExpiryScan (issue #79) — integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a notification for a bill in the 30-day window', async () => {
    const rows = [makeRow({ fixed_term_expiry: daysFromToday(30) })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-1', channel: 'whatsapp' });
    const store = new Map<string, { value: string; expiresAt?: number }>();
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(1);
    expect(result.billsScanned).toBe(1);
    expect(sendText).toHaveBeenCalledOnce();
    const body = sendText.mock.calls[0]![2] as string;
    expect(body).toContain('Meridian');
    // dedup gate set per (user, expiry, window)
    expect(store.has(`fixed_term_expiry:u-1:${daysFromToday(30)}:30d`)).toBe(true);
  });

  it('sends a notification for a bill in the 7-day window with a break-fee note', async () => {
    const rows = [makeRow({
      fixed_term_expiry: daysFromToday(5),
      break_fee_cents: 20000,
    })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-7', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(1);
    const body = sendText.mock.calls[0]![2] as string;
    expect(body).toContain('$200');
    expect(body).toMatch(/break fee/i);
  });

  it('skips a bill already notified in this window (KV dedup)', async () => {
    const expiry = daysFromToday(30);
    const rows = [makeRow({ fixed_term_expiry: expiry })];
    const store = new Map<string, { value: string; expiresAt?: number }>([
      [`fixed_term_expiry:u-1:${expiry}:30d`, { value: '2026-06-20T08:00:00Z' }],
    ]);
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(0);
    expect(result.skippedDedup).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('allows a DIFFERENT window to fire for the same expiry (30d set, 7d not)', async () => {
    // Same expiry, 7 days out — 30d dedup key is set but 7d is not.
    const expiry = daysFromToday(7);
    const rows = [makeRow({ fixed_term_expiry: expiry })];
    const store = new Map<string, { value: string; expiresAt?: number }>([
      [`fixed_term_expiry:u-1:${expiry}:30d`, { value: '2026-06-15T08:00:00Z' }],
    ]);
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-7d', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(1);
    expect(store.has(`fixed_term_expiry:u-1:${expiry}:7d`)).toBe(true);
    sendText.mockRestore();
  });

  it('skips a bill whose holder has no phone number', async () => {
    const rows = [makeRow({ phone: null, fixed_term_expiry: daysFromToday(30) })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(0);
    expect(result.skippedNoPhone).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips a bill outside all windows (e.g. 90 days out)', async () => {
    // The D1 query bounds to 60d, but the classifier is the backstop if a
    // row slipped through. Verify classifyExpiryWindow gates it.
    const rows = [makeRow({ fixed_term_expiry: daysFromToday(90) })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('records a failed audit row and does NOT set the dedup key on send failure', async () => {
    const rows = [makeRow({ fixed_term_expiry: daysFromToday(30) })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockRejectedValue(new Error('sent 500'));
    const store = new Map<string, { value: string; expiresAt?: number }>();
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.failed).toBe(1);
    expect(result.notificationsSent).toBe(0);
    expect(store.has(`fixed_term_expiry:u-1:${daysFromToday(30)}:30d`)).toBe(false);
    sendText.mockRestore();
  });

  it('processes multiple bills independently in one tick', async () => {
    const rows = [
      makeRow({ bill_id: 'b-1', user_id: 'u-1', fixed_term_expiry: daysFromToday(7) }),
      makeRow({ bill_id: 'b-2', user_id: 'u-2', fixed_term_expiry: daysFromToday(60) }),
    ];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const store = new Map<string, { value: string; expiresAt?: number }>();
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
    };

    const result = await runFixedTermExpiryScan(env);

    expect(result.notificationsSent).toBe(2);
    expect(store.has(`fixed_term_expiry:u-1:${daysFromToday(7)}:7d`)).toBe(true);
    expect(store.has(`fixed_term_expiry:u-2:${daysFromToday(60)}:60d`)).toBe(true);
    sendText.mockRestore();
  });

  it('renders "your retailer" when retailer_name is null', async () => {
    const rows = [makeRow({
      fixed_term_expiry: daysFromToday(30),
      retailer_name: null,
    })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(rows),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
    };

    await runFixedTermExpiryScan(env);

    const body = sendText.mock.calls[0]![2] as string;
    expect(body).toContain('your retailer');
    sendText.mockRestore();
  });
});
