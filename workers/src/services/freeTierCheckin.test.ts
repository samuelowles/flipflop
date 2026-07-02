import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyCheckin,
  buildStatusSummary,
  runFreeTierCheckin,
  type CheckinContext,
} from './freeTierCheckin';
import type { PlanComparison } from '../types/comparison';

/**
 * Issue #78 — free-tier monthly check-in tests.
 *
 * Two groups:
 *  1. classifyCheckin / buildStatusSummary — PURE function, all 4 variants.
 *  2. runFreeTierCheckin — integration-ish with mocked D1/KV/Sent, mirroring
 *     planDiffConsumer.test.ts's fake-KV/DB/queue pattern.
 */

const NOW = new Date('2026-07-01T08:00:00Z');
const PAST_EXPIRY = '2026-01-01';
const FUTURE_EXPIRY = '2026-12-31';
const THRESHOLD = 5000; // $50 default

function baseCtx(overrides: Partial<CheckinContext> = {}): CheckinContext {
  return {
    fixedTermExpiry: null,
    latestComparison: null,
    thresholdCents: THRESHOLD,
    now: NOW,
    ...overrides,
  };
}

function fakeComparison(
  overrides: Partial<PlanComparison> = {}
): PlanComparison {
  return {
    id: 'cmp-1',
    userId: 'u-1',
    planId: 'plan-a',
    billIdsJson: null,
    projectedCostCents: 180000,
    currentCostCents: 200000,
    savingCents: 20000, // $200 saving (positive = saving, Python convention)
    confidence: 0.9,
    comparedAt: '2026-06-20T00:00:00Z',
    recommendation: 'switch',
    reason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PURE: classifyCheckin — all 4 variants + boundary cases.
// ---------------------------------------------------------------------------

describe('classifyCheckin (issue #78) — pure variant mapping', () => {
  it('returns wait_until_date when a fixed-term contract has not expired', () => {
    const variant = classifyCheckin(baseCtx({
      fixedTermExpiry: FUTURE_EXPIRY,
      // even a strong switch recommendation is overridden by the lock-in.
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: 99999 }),
    }));
    expect(variant).toBe('wait_until_date');
  });

  it('falls through to comparison logic when the fixed term has expired', () => {
    const variant = classifyCheckin(baseCtx({
      fixedTermExpiry: PAST_EXPIRY,
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: 20000 }),
    }));
    expect(variant).toBe('likely_better_plan');
  });

  it('returns likely_better_plan for switch + saving clearing threshold', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: THRESHOLD }),
    }));
    expect(variant).toBe('likely_better_plan');
  });

  it('returns not_worth_it when saving is positive but below threshold', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: THRESHOLD - 1 }),
    }));
    expect(variant).toBe('not_worth_it');
  });

  it('returns not_worth_it when stay_put reason is low_savings', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({
        recommendation: 'stay_put',
        savingCents: 100,
        reason: 'low_savings',
      }),
    }));
    expect(variant).toBe('not_worth_it');
  });

  it('returns not_worth_it when stay_put reason is no_savings', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({
        recommendation: 'stay_put',
        savingCents: 0,
        reason: 'no_savings',
      }),
    }));
    expect(variant).toBe('not_worth_it');
  });

  it('returns still_fine when stay_put reason is a non-cost reason (recent_switch)', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({
        recommendation: 'stay_put',
        savingCents: 60000,
        reason: 'recent_switch',
      }),
    }));
    expect(variant).toBe('still_fine');
  });

  it('returns still_fine when there is no comparison at all', () => {
    const variant = classifyCheckin(baseCtx({ latestComparison: null }));
    expect(variant).toBe('still_fine');
  });

  it('returns still_fine when stay_put has no reason set', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({
        recommendation: 'stay_put',
        savingCents: 0,
        reason: null,
      }),
    }));
    expect(variant).toBe('still_fine');
  });

  it('treats the threshold as inclusive at the boundary (meets = better)', () => {
    // savingCents === thresholdCents → clearsThreshold is true.
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: THRESHOLD }),
    }));
    expect(variant).toBe('likely_better_plan');
  });

  it('treats a switch with zero saving as still_fine (not better)', () => {
    const variant = classifyCheckin(baseCtx({
      latestComparison: fakeComparison({ recommendation: 'switch', savingCents: 0 }),
    }));
    expect(variant).toBe('still_fine');
  });
});

// ---------------------------------------------------------------------------
// PURE: buildStatusSummary
// ---------------------------------------------------------------------------

describe('buildStatusSummary (issue #78)', () => {
  it('includes the expiry date for wait_until_date', () => {
    const summary = buildStatusSummary('wait_until_date', baseCtx({
      fixedTermExpiry: '2026-12-31T00:00:00Z',
    }));
    expect(summary).toContain('2026-12-31');
  });

  it('includes the dollar saving for likely_better_plan', () => {
    const summary = buildStatusSummary('likely_better_plan', baseCtx({
      latestComparison: fakeComparison({ savingCents: 25000 }),
    }));
    expect(summary).toContain('$250');
  });

  it('returns a non-empty message for not_worth_it and still_fine', () => {
    expect(buildStatusSummary('not_worth_it', baseCtx()).length).toBeGreaterThan(0);
    expect(buildStatusSummary('still_fine', baseCtx()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: runFreeTierCheckin — mocked D1/KV/Sent.
// ---------------------------------------------------------------------------

// In-memory KV fake (mirrors planDiffConsumer.test.ts).
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

// Fake D1 that resolves user data + comparison + fixed-term rows per userId.
interface UserRow {
  readonly id: string;
  readonly phone: string | null;
  readonly subscription_tier: string;
  readonly notification_threshold_cents: number;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone_encrypted: string | null;
  readonly sent_contact_id: string | null;
  readonly stripe_customer_id: string | null;
  readonly current_retailer_id: string | null;
  readonly current_plan_name: string | null;
  readonly icp_number: string | null;
  readonly installation_address: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
}
interface ComparisonRow {
  readonly user_id: string;
  readonly saving_cents: number;
  readonly recommendation: string | null;
  readonly reason: string | null;
}

function createFakeDB(
  users: UserRow[],
  comparisonsByUser: Record<string, ComparisonRow>,
  fixedTermByUser: Record<string, string>
): D1Database {
  const pickUser = (id: string) => users.find(u => u.id === id);

  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const arg = args[0];
        // getFreeTierUsers: SELECT id FROM users WHERE subscription_tier = 'free'
        if (sql.includes('SELECT id FROM users') && sql.includes('subscription_tier')) {
          return {
            all: async () => ({
              results: users.filter(u => u.subscription_tier === 'free').map(u => ({ id: u.id })),
              success: true,
              meta: {},
            }),
            first: async () => null,
            run: async () => ({ success: true, meta: {} }),
          };
        }
        // getNotificationThreshold / getUserById: SELECT * FROM users WHERE id
        if (sql.includes('SELECT * FROM users') && sql.includes('id =')) {
          const row = pickUser(String(arg));
          return {
            first: async () => row ?? null,
            all: async () => ({ results: row ? [row] : [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: {} }),
          };
        }
        // getLatestComparisonForUser
        if (sql.includes('plan_comparisons')) {
          const c = comparisonsByUser[String(arg)];
          return {
            first: async () => c ?? null,
            all: async () => ({ results: c ? [c] : [], success: true, meta: {} }),
            run: async () => ({ success: true, meta: {} }),
          };
        }
        // getLatestFixedTermForUser
        if (sql.includes('fixed_term_expiry') && sql.includes('bills')) {
          const exp = fixedTermByUser[String(arg)];
          return {
            first: async () => (exp !== undefined ? { fixed_term_expiry: exp } : null),
            all: async () => ({ results: [], success: true, meta: {} }),
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

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-1',
    phone: '+6421555999',
    subscription_tier: 'free',
    notification_threshold_cents: THRESHOLD,
    name: null,
    email: null,
    phone_encrypted: null,
    sent_contact_id: null,
    stripe_customer_id: null,
    current_retailer_id: null,
    current_plan_name: null,
    icp_number: null,
    installation_address: null,
    state: 'idle',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('runFreeTierCheckin (issue #78) — integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a likely_better_plan check-in to a free-tier switch candidate', async () => {
    const users = [makeUser({ id: 'u-1' })];
    const comparisons = {
      'u-1': { user_id: 'u-1', saving_cents: 20000, recommendation: 'switch', reason: null },
    };
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-1', channel: 'whatsapp' });
    const store = new Map<string, { value: string; expiresAt?: number }>();
    const env = {
      DB: createFakeDB(users, comparisons, {}),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    expect(result.notificationsSent).toBe(1);
    expect(result.usersChecked).toBe(1);
    expect(sendText).toHaveBeenCalledOnce();
    // dedup gate set
    expect(store.has('free_tier_checkin:u-1')).toBe(true);
    // body includes the saving dollar figure
    const body = (sendText.mock.calls[0]![2] as string);
    expect(body).toContain('$200');
  });

  it('skips a user already sent within the 28-day dedup window', async () => {
    const users = [makeUser({ id: 'u-1' })];
    const comparisons = {
      'u-1': { user_id: 'u-1', saving_cents: 20000, recommendation: 'switch', reason: null },
    };
    const store = new Map<string, { value: string; expiresAt?: number }>([
      ['free_tier_checkin:u-1', { value: '2026-06-15T08:00:00Z' }],
    ]);
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-x', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(users, comparisons, {}),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    expect(result.notificationsSent).toBe(0);
    expect(result.skippedDedup).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips a user with no phone number on file', async () => {
    const users = [makeUser({ id: 'u-1', phone: null })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(users, {}, {}),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    expect(result.notificationsSent).toBe(0);
    expect(result.skippedNoPhone).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sends wait_until_date when the user has an unexpired fixed term', async () => {
    const users = [makeUser({ id: 'u-1' })];
    const comparisons = {
      'u-1': { user_id: 'u-1', saving_cents: 99999, recommendation: 'switch', reason: null },
    };
    const fixedTerms = { 'u-1': FUTURE_EXPIRY };
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg-w', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(users, comparisons, fixedTerms),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    expect(result.notificationsSent).toBe(1);
    const body = (sendText.mock.calls[0]![2] as string);
    expect(body).toContain('2026-12-31');
  });

  it('records a failed audit row and does NOT set the dedup key on send failure', async () => {
    const users = [makeUser({ id: 'u-1' })];
    const comparisons = {
      'u-1': { user_id: 'u-1', saving_cents: 20000, recommendation: 'switch', reason: null },
    };
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockRejectedValue(new Error('sent 500'));
    const store = new Map<string, { value: string; expiresAt?: number }>();
    const env = {
      DB: createFakeDB(users, comparisons, {}),
      KV: createFakeKV(store),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    // AC: failure must not set the dedup key (so the next tick can retry).
    expect(result.failed).toBe(1);
    expect(result.notificationsSent).toBe(0);
    expect(store.has('free_tier_checkin:u-1')).toBe(false);
    sendText.mockRestore();
  });

  it('ignores paid-tier users entirely', async () => {
    const users = [makeUser({ id: 'u-1', subscription_tier: 'paid' })];
    const sendText = vi.spyOn(await import('./messaging'), 'sendText')
      .mockResolvedValue({ messageId: 'msg', channel: 'whatsapp' });
    const env = {
      DB: createFakeDB(users, {}, {}),
      KV: createFakeKV(new Map()),
      SENT_API_KEY: 'k',
      ENCRYPTION_KEY: 'enc',
    };

    const result = await runFreeTierCheckin(env);

    expect(result.usersChecked).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    sendText.mockRestore();
  });
});
