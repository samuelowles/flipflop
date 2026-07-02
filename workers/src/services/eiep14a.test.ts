import { describe, it, expect } from 'vitest';
import { isEiep14aEnabled, computeContentHash, transformRecords, type EnvWithPlans } from './eiep14a';
import { upsertPlan, computeChangedFields } from '../models/plans';
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
    source_url: null,
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


describe('transformRecords field mapping (issue #65)', () => {
  it('folds rate_type + gst_inclusive into conditions_json', () => {
    const plans = transformRecords([{
      Retailer: 'Contact',
      PlanName: 'Anytime Plan',
      PlanId: 'C-001',
      Region: 'Auckland',
      VariableRate: 25.5,
      DailyCharge: 2.0,
      RateType: 'anytime',
      GSTInclusive: 'yes',
    }]);
    expect(plans).toHaveLength(1);
    const cond = JSON.parse(plans[0]!.conditions_json);
    expect(cond.rate_type).toBe('ANYTIME');
    expect(cond.gst_inclusive).toBe(true);
  });

  it('defaults gst_inclusive to true when absent (feed spec)', () => {
    const plans = transformRecords([{
      Retailer: 'Mercury', PlanName: 'P', PlanId: 'M-1', Region: 'Wellington',
    }]);
    const cond = JSON.parse(plans[0]!.conditions_json);
    expect(cond.gst_inclusive).toBe(true);
  });

  it('propagates per-record SourceURL into source_url', () => {
    const plans = transformRecords([{
      Retailer: 'Genesis', PlanName: 'P', PlanId: 'G-1', Region: 'Auckland',
      SourceURL: 'https://example.com/feed.json',
    }]);
    expect(plans[0]!.source_url).toBe('https://example.com/feed.json');
  });

  it('leaves source_url null when no per-record URL is present', () => {
    const plans = transformRecords([{
      Retailer: 'Genesis', PlanName: 'P', PlanId: 'G-2', Region: 'Auckland',
    }]);
    expect(plans[0]!.source_url).toBeNull();
  });
});

/**
 * Minimal in-memory D1 mock: only the statements upsertPlan uses.
 * Tracks INSERTs and UPDATEs separately so #68 tests can assert that the old
 * row was retired (is_current=0) AND a fresh row was inserted, rather than a
 * single in-place UPDATE.
 */
function mockD1(existing: Record<string, unknown> | null) {
  const updates: Array<{ args: unknown[]; sql: string }> = [];
  const inserts: Array<{ args: unknown[]; sql: string }> = [];
  // Tracks the last inserted row's synthetic shape so the createPlan()
  // re-read (SELECT * FROM plans WHERE id=?) finds it. The id is args[0] of
  // the INSERT bind list; the rest is inferred from the test's planInput.
  let lastInserted: Record<string, unknown> | null = null;

  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop) => {
      if (prop === 'prepare') {
        return (sql: string) => {
          const trimmed = sql.trim().replace(/\s+/g, ' ');
          const bind = (...args: unknown[]) => ({
            run: async () => {
              if (trimmed.startsWith('UPDATE')) updates.push({ args, sql: trimmed });
              else if (trimmed.startsWith('INSERT')) {
                inserts.push({ args, sql: trimmed });
                lastInserted = { id: args[0] };
              }
            },
            first: async () => {
              // The id/content_hash probe (#64 fast path).
              if (trimmed.startsWith('SELECT id, content_hash')) return existing;
              // Full-row re-read (createPlan getPlanById / computeChangedFields).
              if (trimmed.startsWith('SELECT') && trimmed.includes('FROM plans WHERE id')) {
                return existing ?? lastInserted;
              }
              return existing ?? lastInserted;
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
  it('returns change_type "unchanged" when content_hash matches existing row (no writes)', async () => {
    const { db, updates, inserts } = mockD1({ id: 'row-1', content_hash: 'MATCH' });
    const result = await upsertPlan(db, planInput('MATCH'));
    expect(result.changeType).toBe('unchanged');
    expect(result.changedFields).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('returns change_type "updated" when content_hash differs (retire + insert)', async () => {
    const { db, updates, inserts } = mockD1({ id: 'row-1', content_hash: 'OLD' });
    const result = await upsertPlan(db, planInput('NEW'));
    expect(result.changeType).toBe('updated');
    expect(result.retiredPlanId).toBe('row-1');
    expect(updates).toHaveLength(1);          // retire old row
    expect(inserts).toHaveLength(1);          // new is_current=1 row
    const retire = updates[0]!;
    expect(retire.sql).toContain('is_current = 0');
  });

  it('returns change_type "updated" when existing row has no content_hash', async () => {
    const { db, updates } = mockD1({ id: 'row-1', content_hash: null });
    const result = await upsertPlan(db, planInput('NEW'));
    expect(result.changeType).toBe('updated');
    expect(updates.length + 0).toBeGreaterThanOrEqual(1);
  });
});

describe('upsertPlan versioned replace (issue #68)', () => {
  it('"created" when no existing row (new plan)', async () => {
    const { db, updates, inserts } = mockD1(null);
    const result = await upsertPlan(db, planInput('HASH'));
    expect(result.changeType).toBe('created');
    expect(result.changedFields).toEqual([]);
    expect(result.retiredPlanId).toBeNull();
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(1);
  });

  it('retires old row (is_current=0) and inserts new row on field change', async () => {
    const existingRow = {
      id: 'row-1',
      content_hash: 'OLD',
      // full-row fields — cPerKwh differs from input (12.34 vs 99.9)
      c_per_kwh: 99.9,
      c_per_day: 1.5,
      tier_thresholds_json: '[]',
      prompt_payment_discount: 0,
      conditions_json: '{}',
      low_user_eligible: 1,
      region: 'Auckland',
      name: 'Good Time',
      retailer_id: 'contact',
    };
    const { db, updates, inserts } = mockD1(existingRow);
    const result = await upsertPlan(db, planInput('NEW'));
    expect(result.changeType).toBe('updated');
    expect(result.changedFields).toContain('c_per_kwh');
    expect(result.changedFields).not.toContain('name');
    expect(updates).toHaveLength(1);
    const retire = updates[0]!;
    expect(retire.sql).toMatch(/is_current\s*=\s*0/);
    expect(retire.sql).toMatch(/effective_to/);
    expect(inserts).toHaveLength(1);
  });

  it('identical re-fetch is a no-op: no rows touched', async () => {
    const { db, updates, inserts } = mockD1({ id: 'row-1', content_hash: 'SAME' });
    const result = await upsertPlan(db, planInput('SAME'));
    expect(result.changeType).toBe('unchanged');
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('computeChangedFields (issue #68)', () => {
  const base = {
    cPerKwh: 12.34, cPerDay: 1.5, tierThresholdsJson: '[]',
    promptPaymentDiscount: 0, conditionsJson: '{}', lowUserEligible: true,
    region: 'Auckland' as string | null, name: 'Good Time',
  };

  it('returns [] when nothing changed', () => {
    expect(computeChangedFields(base, base)).toEqual([]);
  });

  it('names every changed tracked field', () => {
    const next = {
      ...base,
      cPerKwh: 99.9, region: 'Wellington', name: 'Better Time',
    };
    const changed = computeChangedFields(base, next);
    expect(changed).toContain('c_per_kwh');
    expect(changed).toContain('region');
    expect(changed).toContain('name');
    expect(changed).not.toContain('c_per_day');
  });

  it('flags low_user_eligible toggle', () => {
    const next = { ...base, lowUserEligible: false };
    expect(computeChangedFields(base, next)).toContain('low_user_eligible');
  });
});
