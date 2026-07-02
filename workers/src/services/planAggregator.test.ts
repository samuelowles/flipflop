import { describe, it, expect } from 'vitest';
import {
  getCanonicalPlans,
  normalizePlanName,
  resolveCanonicalForGroup,
  SOURCE_RANK,
} from './planAggregator';
import type { Plan } from '../types/plan';

/**
 * Issue #69 tests — Plan data aggregator + source preference logic.
 *
 * The four AC scenarios:
 *   (a) manual wins when a manual row exists for retailer+region+plan
 *   (b) eiep14a preferred over powerswitch for the same retailer+region+plan
 *   (c) powerswitch is the fallback ONLY when eiep14a has no usable plan
 *   (d) incomplete rows (null c_per_kwh AND null tier_thresholds_json) dropped
 *
 * Uses a minimal D1 mock (the established pattern in usageTracker.test.ts):
 * `getCanonicalPlans` only reads via `getPlansByRegion`, which issues a single
 * SELECT against `plans WHERE region = ?`. Each scenario hands the aggregator
 * an explicit row set, so precedence is asserted deterministically without
 * depending on seed-data state.
 */

function mockD1(rows: Record<string, unknown>[]): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({}),
      }),
    }),
  } as unknown as D1Database;
}

const RETAILER = 'retailer-contact';
const REGION = 'Auckland';
const NOW = '2026-07-02T00:00:00Z';

/**
 * Build a Plan row in D1 column shape. Defaults make a complete, active row.
 * Uses `key in overrides` (not `??`) so an explicit `null` override is
 * respected — otherwise `c_per_kwh: null` would be silently coerced to 25.0.
 */
function row(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  const pick = <T>(key: string, def: T): T =>
    key in overrides ? (overrides[key] as T) : def;
  return {
    id: pick('id', 'plan-x'),
    retailer_id: pick('retailer_id', RETAILER),
    name: pick('name', 'Standard User'),
    region: pick('region', REGION),
    c_per_kwh: pick('c_per_kwh', 25.0),
    c_per_day: pick('c_per_day', 90.0),
    tier_thresholds_json: pick('tier_thresholds_json', null),
    prompt_payment_discount: pick('prompt_payment_discount', 0),
    conditions_json: pick('conditions_json', '{}'),
    low_user_eligible: pick('low_user_eligible', 0),
    source: pick('source', 'manual'),
    eiep14a_id: pick('eiep14a_id', null),
    effective_from: pick('effective_from', NOW),
    effective_to: pick('effective_to', null),
    provenance: pick('provenance', 'manual'),
    source_url: pick('source_url', null),
    ingested_at: pick('ingested_at', NOW),
    content_hash: pick('content_hash', null),
    is_current: pick('is_current', 1),
  };
}

function toPlan(r: Record<string, unknown>): Plan {
  return {
    id: r.id as string,
    retailerId: r.retailer_id as string,
    name: r.name as string,
    region: r.region as string | null,
    cPerKwh: (r.c_per_kwh as number | null) ?? null,
    cPerDay: (r.c_per_day as number | null) ?? null,
    tierThresholdsJson: (r.tier_thresholds_json as string | null) ?? null,
    promptPaymentDiscount: (r.prompt_payment_discount as number | null) ?? null,
    conditionsJson: (r.conditions_json as string | null) ?? null,
    lowUserEligible: (r.low_user_eligible as number) === 1,
    source: r.source as Plan['source'],
    eiep14aId: (r.eiep14a_id as string | null) ?? null,
    effectiveFrom: (r.effective_from as string | null) ?? null,
    effectiveTo: (r.effective_to as string | null) ?? null,
    provenance: (r.provenance as Plan['provenance']) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    ingestedAt: (r.ingested_at as string | null) ?? null,
    contentHash: (r.content_hash as string | null) ?? null,
    isCurrent: (r.is_current as number) === 1,
  };
}

describe('SOURCE_RANK precedence (issue #69)', () => {
  it('ranks manual (1) > eiep14a (2) > powerswitch (3)', () => {
    expect(SOURCE_RANK.manual!).toBeLessThan(SOURCE_RANK.eiep14a!);
    expect(SOURCE_RANK.eiep14a!).toBeLessThan(SOURCE_RANK.powerswitch!);
  });
});

describe('normalizePlanName (issue #69 equivalence grouping)', () => {
  it('lowercases and collapses non-alphanumerics', () => {
    expect(normalizePlanName('Good Time Energy!')).toBe('good time energy');
    expect(normalizePlanName('good-time')).toBe('good time');
    expect(normalizePlanName('Standard   User')).toBe('standard user');
  });

  it('makes case/format variants equivalent', () => {
    expect(normalizePlanName('Good Time')).toBe(normalizePlanName('good time'));
    expect(normalizePlanName('Good-Time!')).toBe(normalizePlanName('good time'));
  });
});

/**
 * AC (a): manual wins when a manual row exists for retailer + region + plan.
 */
describe('AC (a): manual wins over eiep14a and powerswitch', () => {
  it('returns the manual row when all three sources have the same plan', async () => {
    const db = mockD1([
      row({ id: 'm1', provenance: 'manual', source: 'manual', c_per_kwh: 25.0 }),
      row({ id: 'e1', provenance: 'eiep14a', source: 'eiep14a', c_per_kwh: 26.0 }),
      row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch', c_per_kwh: 27.0 }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('m1');
    expect(canonical[0]!.provenance).toBe('manual');
  });

  it('manual wins even when eiep14a/powerswitch rows were ingested later', async () => {
    const db = mockD1([
      row({ id: 'm1', provenance: 'manual', source: 'manual', ingested_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'e1', provenance: 'eiep14a', source: 'eiep14a', ingested_at: '2026-07-02T00:00:00Z' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical[0]!.id).toBe('m1');
  });
});

/**
 * AC (b): eiep14a preferred over powerswitch for the same retailer + region +
 * equivalent plan when EIEP14A coverage is present.
 */
describe('AC (b): eiep14a preferred over powerswitch', () => {
  it('returns the eiep14a row when no manual row exists', async () => {
    const db = mockD1([
      row({ id: 'e1', provenance: 'eiep14a', source: 'eiep14a', c_per_kwh: 24.0 }),
      row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch', c_per_kwh: 25.0 }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('e1');
    expect(canonical[0]!.provenance).toBe('eiep14a');
  });

  it('groups equivalent plan-name variants and picks eiep14a', async () => {
    const db = mockD1([
      row({ id: 'e1', name: 'Good-Time', provenance: 'eiep14a', source: 'eiep14a' }),
      row({ id: 'p1', name: 'good time', provenance: 'powerswitch', source: 'powerswitch' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('e1');
  });
});

/**
 * AC (c): powerswitch is the fallback ONLY when eiep14a has no usable plan.
 */
describe('AC (c): powerswitch fallback when eiep14a absent', () => {
  it('returns the powerswitch row when only powerswitch covers the plan', async () => {
    const db = mockD1([
      row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch', c_per_kwh: 25.5 }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('p1');
    expect(canonical[0]!.provenance).toBe('powerswitch');
  });

  it('returns distinct plans per retailer when each has a different best source', async () => {
    const db = mockD1([
      // Retailer A: manual wins
      row({ id: 'a-manual', retailer_id: 'retailer-a', name: 'Std', provenance: 'manual', source: 'manual' }),
      row({ id: 'a-eiep', retailer_id: 'retailer-a', name: 'Std', provenance: 'eiep14a', source: 'eiep14a' }),
      // Retailer B: eiep14a wins (no manual)
      row({ id: 'b-eiep', retailer_id: 'retailer-b', name: 'Std', provenance: 'eiep14a', source: 'eiep14a' }),
      row({ id: 'b-ps', retailer_id: 'retailer-b', name: 'Std', provenance: 'powerswitch', source: 'powerswitch' }),
      // Retailer C: powerswitch only
      row({ id: 'c-ps', retailer_id: 'retailer-c', name: 'Std', provenance: 'powerswitch', source: 'powerswitch' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(3);
    const byRetailer = new Map(canonical.map((p) => [p.retailerId, p.id]));
    expect(byRetailer.get('retailer-a')).toBe('a-manual');
    expect(byRetailer.get('retailer-b')).toBe('b-eiep');
    expect(byRetailer.get('retailer-c')).toBe('c-ps');
  });
});

/**
 * AC (d): incomplete rows (null c_per_kwh AND null tier_thresholds_json) are
 * excluded from the canonical set.
 */
describe('AC (d): incomplete rows excluded', () => {
  it('drops a row with null c_per_kwh AND null tier_thresholds_json', async () => {
    const db = mockD1([
      row({ id: 'incomplete', provenance: 'eiep14a', source: 'eiep14a', c_per_kwh: null, tier_thresholds_json: null }),
      row({ id: 'complete', provenance: 'powerswitch', source: 'powerswitch', c_per_kwh: 25.0 }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('complete');
  });

  it('keeps a row that has a tier schedule but no flat c_per_kwh', async () => {
    const db = mockD1([
      row({ id: 'tou', provenance: 'eiep14a', source: 'eiep14a', c_per_kwh: null, tier_thresholds_json: '{"peak":30,"off_peak":18}' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('tou');
  });

  it('keeps a row that has a flat c_per_kwh but no tier schedule', async () => {
    const db = mockD1([
      row({ id: 'flat', provenance: 'powerswitch', source: 'powerswitch', c_per_kwh: 24.5, tier_thresholds_json: null }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.id).toBe('flat');
  });
});

/**
 * #157 STUB coverage — manual source returns no rows (the pre-#157 state).
 * eiep14a > powerswitch precedence must still resolve correctly.
 */
describe('#157 stub: manual absent still resolves eiep14a > powerswitch', () => {
  it('falls back to eiep14a when no manual rows exist', async () => {
    const db = mockD1([
      row({ id: 'e1', provenance: 'eiep14a', source: 'eiep14a' }),
      row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical[0]!.provenance).toBe('eiep14a');
  });

  it('falls back to powerswitch when neither manual nor eiep14a exist', async () => {
    const db = mockD1([
      row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch' }),
    ]);
    const canonical = await getCanonicalPlans(db, REGION);
    expect(canonical[0]!.provenance).toBe('powerswitch');
  });
});

describe('resolveCanonicalForGroup (direct precedence pick)', () => {
  it('picks manual over powerswitch given a mixed group', () => {
    const group = [
      toPlan(row({ id: 'p1', provenance: 'powerswitch', source: 'powerswitch' })),
      toPlan(row({ id: 'm1', provenance: 'manual', source: 'manual' })),
      toPlan(row({ id: 'e1', provenance: 'eiep14a', source: 'eiep14a' })),
    ];
    expect(resolveCanonicalForGroup(group).id).toBe('m1');
  });

  it('tie-breaks on is_current then recency within the same source', () => {
    const group = [
      toPlan(row({ id: 'old', provenance: 'eiep14a', source: 'eiep14a', is_current: 1, ingested_at: '2026-01-01T00:00:00Z' })),
      toPlan(row({ id: 'new', provenance: 'eiep14a', source: 'eiep14a', is_current: 1, ingested_at: '2026-06-01T00:00:00Z' })),
    ];
    expect(resolveCanonicalForGroup(group).id).toBe('new');
  });
});
