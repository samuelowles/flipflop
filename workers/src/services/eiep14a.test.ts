import { describe, it, expect } from 'vitest';
import { isEiep14aEnabled, computeContentHash, type EnvWithPlans } from './eiep14a';
import { upsertPlan } from '../models/plans';
import type { Plan } from '../types/plan';

/**
 * Issue #64 tests: EIEP14A gate + hash-based idempotency.
 */

describe('isEiep14aEnabled (issue #64 gate)', () => {
  const base: EnvWithPlans = { DB: {} as D1Database, KV: {} as KVNamespace };

  it('returns false when flag absent (INERT default)', () => {
    expect(isEiep14aEnabled(base)).toBe(false);
  });

  it('returns false when flag is "false"', () => {
    expect(isEiep14aEnabled({ ...base, EIF_EIEP14A_ENABLED: 'false' })).toBe(false);
  });

  it('returns true only when flag is exactly "true"', () => {
    expect(isEiep14aEnabled({ ...base, EIF_EIEP14A_ENABLED: 'true' })).toBe(true);
  });

  it('is case-sensitive ("True" does not arm)', () => {
    expect(isEiep14aEnabled({ ...base, EIF_EIEP14A_ENABLED: 'True' })).toBe(false);
  });
});

describe('computeContentHash (issue #64 idempotency)', () => {
  const plan = {
    retailer_id: 'contact',
    name: 'Good Time',
    region: 'Auckland',
    c_per_kwh: 12.34,
    c_per_day: 1.5,
    tier_thresholds_json: '[]',
    prompt_payment_discount: 0,
    conditions_json: '{}',
    low_user_eligible: 1,
    source: 'eiep14a',
    eiep14a_id: 'abc',
    effective_from: '2026-07-02T00:00:00Z',
  };

  it('is deterministic for identical tracked fields', async () => {
    const a = await computeContentHash(plan);
    const b = await computeContentHash(plan);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a tracked field changes', async () => {
    const a = await computeContentHash(plan);
    const b = await computeContentHash({ ...plan, c_per_kwh: 99.9 });
    expect(a).not.toBe(b);
  });

  it('ignores non-tracked fields (effective_from)', async () => {
    const a = await computeContentHash(plan);
    const b = await computeContentHash({ ...plan, effective_from: '1999-01-01' });
    expect(a).toBe(b);
  });
});

/**
 * Minimal in-memory D1 mock: only the statements upsertPlan uses.
 * Tracks calls so we can assert whether an UPDATE was issued.
 */
function mockD1(existing: Record<string, unknown> | null) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];

  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop) => {
      if (prop === 'prepare') {
        return (sql: string) => {
          const trimmed = sql.trim().replace(/\s+/g, ' ');
          const bind = (...args: unknown[]) => ({
            run: async () => {
              if (trimmed.startsWith('UPDATE')) updates.push(args);
              else if (trimmed.startsWith('INSERT')) inserts.push(args);
            },
            first: async () => {
              if (trimmed.startsWith('SELECT id, content_hash')) return existing;
              if (trimmed.startsWith('SELECT id FROM plans')) {
                return existing ? { id: existing.id } : null;
              }
              if (trimmed.startsWith('SELECT')) return existing;
              return null;
            },
          });
          return { bind };
        };
      }
      return undefined;
    },
  };

  return { db: new Proxy({} as Record<string, unknown>, handler) as unknown as D1Database, updates, inserts };
}

const planInput = (contentHash: string | null): Omit<Plan, 'id'> => ({
  retailerId: 'contact',
  name: 'Good Time',
  region: 'Auckland',
  cPerKwh: 12.34,
  cPerDay: 1.5,
  tierThresholdsJson: '[]',
  promptPaymentDiscount: 0,
  conditionsJson: '{}',
  lowUserEligible: true,
  source: 'eiep14a',
  eiep14aId: 'eiep-1',
  effectiveFrom: '2026-07-02T00:00:00Z',
  effectiveTo: null,
  provenance: 'eiep14a',
  sourceUrl: null,
  ingestedAt: null,
  contentHash,
  isCurrent: true,
});

describe('upsertPlan hash-based idempotency (issue #64)', () => {
  it('skips UPDATE when content_hash matches existing row', async () => {
    const { db, updates } = mockD1({ id: 'row-1', content_hash: 'MATCH' });
    const { changed } = await upsertPlan(db, planInput('MATCH'));
    expect(changed).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('issues UPDATE when content_hash differs', async () => {
    const { db, updates } = mockD1({ id: 'row-1', content_hash: 'OLD' });
    const { changed } = await upsertPlan(db, planInput('NEW'));
    expect(changed).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it('issues UPDATE when existing row has no content_hash', async () => {
    const { db, updates } = mockD1({ id: 'row-1', content_hash: null });
    const { changed } = await upsertPlan(db, planInput('NEW'));
    expect(changed).toBe(true);
    expect(updates).toHaveLength(1);
  });
});
