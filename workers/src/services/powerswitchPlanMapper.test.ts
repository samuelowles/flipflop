import { describe, it, expect } from 'vitest';
import {
  mapPowerswitchPlan,
  mapPowerswitchPlans,
  tariffContentHash,
} from './powerswitchPlanMapper';
import { parseRscResults } from './powerswitchRscParser';
import { rsc_results_flight } from './powerswitchLiveFixtures';
import type { ParsedPlan, ParsedTariff } from './powerswitchRscParser';

/**
 * Issue #240 — Powerswitch tariff → comparator plan mapper, rebuilt against the
 * REAL capture. Tests the mapping rules (real units $/kWh→cents ×100, PK/OP TOU
 * blend, TD3 positive-% discount, low-user, fixed-term) and unit parity with
 * the captured annual_cost (the strongest correctness check available offline).
 */

function mkPlan(
  id: string,
  name: string,
  retailerId: string,
  tariffs: ParsedTariff[],
  opts: { fixedTerm?: boolean; priceChangeDue?: boolean | string } = {}
): ParsedPlan {
  return {
    id,
    name,
    retailerId,
    energyType: 'electricity',
    fixedTerm: opts.fixedTerm ?? false,
    priceChangeDue: opts.priceChangeDue ?? false,
    tariffs,
  };
}

/** mkTariff: value is $/kWh (amount) or a fraction (percentage), matching real units. */
function mkTariff(
  code: string,
  value: number,
  register: string,
  displayType: 'amount' | 'percentage' = 'amount'
): ParsedTariff {
  return { code, name: code, value, displayType, registerContentCode: register };
}

describe('mapPowerswitchPlan — single-rate plan ($/kWh → cents ×100)', () => {
  const flat = mkPlan('p1', 'Flat Plan', 'retailer', [
    mkTariff('F', 1.8, 'F'),
    mkTariff('N1', 0.288, 'IN'),
  ]);

  it('maps F $/day → c_per_day (×100)', () => {
    expect(mapPowerswitchPlan(flat)!.plan.c_per_day).toBe(180); // 1.8 $/day → 180 c/day
  });

  it('maps the IN $/kWh register → c_per_kwh (×100)', () => {
    expect(mapPowerswitchPlan(flat)!.plan.c_per_kwh).toBe(28.8); // 0.288 → 28.8 c/kWh
  });

  it('does NOT flag is_tou (pricing.py would otherwise drop the plan)', () => {
    const conditions = JSON.parse(mapPowerswitchPlan(flat)!.plan.conditions_json as string);
    expect(conditions.is_tou).toBeUndefined();
    expect(conditions.register_type).toBe('flat');
  });

  it('adds per-kWh levies (EC) into c_per_kwh', () => {
    const withLevy = mkPlan('p1b', 'Flat + Levy', 'retailer', [
      mkTariff('F', 1.8, 'F'),
      mkTariff('N1', 0.288, 'IN'),
      mkTariff('EC', 0.0019, 'EC'),
    ]);
    // (0.288 + 0.0019) × 100 = 28.99
    expect(mapPowerswitchPlan(withLevy)!.plan.c_per_kwh).toBe(28.99);
  });

  it('carries fixed_term + price_change_due into conditions', () => {
    const plan = mkPlan(
      'p2', 'Term Plan', 'ret',
      [mkTariff('F', 2.0, 'F'), mkTariff('N1', 0.3, 'IN')],
      { fixedTerm: true, priceChangeDue: true }
    );
    const conditions = JSON.parse(mapPowerswitchPlan(plan)!.plan.conditions_json as string);
    expect(conditions.fixed_term).toBe(true);
    expect(conditions.price_change_due).toBe(true);
    expect(conditions.source).toBe('powerswitch_user');
  });

  it('has an empty caveat for a plain single-rate plan', () => {
    expect(mapPowerswitchPlan(flat)!.caveat).toBe('');
  });
});

describe('mapPowerswitchPlan — TOU plan (PK + OP, blended, NOT is_tou)', () => {
  // Real values from 176000 Sunday Saver: PK 0.3567, OP 0.321, F 1.8.
  const tou = mkPlan('p3', 'Sunday Saver', 'Electric Kiwi', [
    mkTariff('F', 1.8, 'F'),
    mkTariff('D1', 0.3567, 'PK'),
    mkTariff('N1', 0.321, 'OP'),
  ]);

  it('blends peak/off-peak into a single c_per_kwh (70/30 split, ×100)', () => {
    // (0.3567×0.7 + 0.321×0.3) × 100 = round(34.599, 2) = 34.60
    expect(mapPowerswitchPlan(tou)!.plan.c_per_kwh).toBe(34.6);
  });

  it('still maps F → c_per_day', () => {
    expect(mapPowerswitchPlan(tou)!.plan.c_per_day).toBe(180);
  });

  it('marks register_type=tou but does NOT set is_tou', () => {
    const conditions = JSON.parse(mapPowerswitchPlan(tou)!.plan.conditions_json as string);
    expect(conditions.register_type).toBe('tou');
    expect(conditions.peak_share).toBe(0.7);
    expect(conditions.is_tou).toBeUndefined();
  });

  it('carries a TOU caveat that names the split + "modelled"', () => {
    const caveat = mapPowerswitchPlan(tou)!.caveat;
    expect(caveat).toContain('TOU');
    expect(caveat).toContain('70/30');
    expect(caveat).toContain('modelled');
  });

  it('treats an empty off-peak register as off-peak when a peak exists (180418 shape)', () => {
    const flex = mkPlan('p3b', 'Flex Low Use', 'Mercury', [
      mkTariff('F', 1.5, 'F'),
      mkTariff('D1', 0.3337, 'PK'),
      mkTariff('N1', 0.2452, ''), // empty register_content_code = off-peak
    ]);
    const m = mapPowerswitchPlan(flex)!;
    // Blended, not flat: (0.3337×0.7 + 0.2452×0.3)×100 = round(30.715,2) = 30.72
    expect(m.plan.c_per_kwh).toBe(30.72);
    expect(JSON.parse(m.plan.conditions_json as string).register_type).toBe('tou');
  });
});

describe('mapPowerswitchPlan — TD3 percentage (assumed % free)', () => {
  const withTd3 = mkPlan('p4', 'Discounted Plan', 'Contact Energy', [
    mkTariff('F', 1.8, 'F'),
    mkTariff('N1', 0.316, 'IN'),
    mkTariff('TD3', 0.15, 'TD3', 'percentage'), // 15% free, as a fraction
  ]);

  it('models the % free as prompt_payment_discount (fraction ×100)', () => {
    // 0.15 × 100 = 15
    expect(mapPowerswitchPlan(withTd3)!.plan.prompt_payment_discount).toBe(15);
  });

  it('carries a modelled-discount caveat', () => {
    const m = mapPowerswitchPlan(withTd3)!;
    expect(m.caveat).toContain('modelled');
    expect(m.caveat).toContain('15%');
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.modelled_discount_note).toContain('15%');
  });

  it('ignores zero-value percentage tariffs (PP/ED discounts encoded as 0)', () => {
    const plan = mkPlan('p4b', 'PP Plan', 'ret', [
      mkTariff('F', 1.8, 'F'),
      mkTariff('N1', 0.285, 'IN'),
      mkTariff('PP', 0, 'PP', 'percentage'),
    ]);
    expect(mapPowerswitchPlan(plan)!.plan.prompt_payment_discount).toBeUndefined();
  });
});

describe('mapPowerswitchPlan — low-user variant', () => {
  it('marks low_user_eligible=true when the name contains "low user"', () => {
    const plan = mkPlan('p5', 'Basic All Day Economy (Low User)', 'ret', [
      mkTariff('F', 1.8, 'F'),
      mkTariff('N1', 0.288, 'IN'),
    ]);
    expect(mapPowerswitchPlan(plan)!.plan.low_user_eligible).toBe(true);
  });

  it('leaves low_user_eligible=false for standard plans', () => {
    const plan = mkPlan('p6', 'Standard Plan', 'ret', [
      mkTariff('F', 2.0, 'F'),
      mkTariff('N1', 0.3, 'IN'),
    ]);
    expect(mapPowerswitchPlan(plan)!.plan.low_user_eligible).toBe(false);
  });
});

describe('mapPowerswitchPlan — unpriceable plans', () => {
  it('returns null when a plan has neither a rate nor a daily charge', () => {
    const plan = mkPlan('p7', 'Weird Plan', 'ret', [
      mkTariff('TD3', 0.15, 'TD3', 'percentage'),
    ]);
    expect(mapPowerswitchPlan(plan)).toBeNull();
  });
});

describe('mapPowerswitchPlans — real capture (15 plans / 9 retailers)', () => {
  it('maps all 15 plans (every plan carries an F charge) with TOU + discount caveats', () => {
    const parsed = parseRscResults(rsc_results_flight);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;

    const { plans, caveats } = mapPowerswitchPlans(parsed.results.plans);
    expect(plans).toHaveLength(15);
    // The capture has TOU plans (176000, 170677, …) and TD3 discounts (176000, 177224, …).
    expect(caveats).toContain('TOU');
    expect(caveats).toContain('modelled');
    // Retailer name rides through as retailer_id.
    expect(plans.some((m) => m.plan.retailer_id === 'Electric Kiwi')).toBe(true);
  });

  it('produces a deterministic content hash per plan', () => {
    const parsed = parseRscResults(rsc_results_flight);
    if (parsed.status !== 'ok') return;
    const h1 = tariffContentHash(parsed.results.plans[0]!);
    const h2 = tariffContentHash(parsed.results.plans[0]!);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^ps_[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// Unit parity vs the captured annual_cost (python/comparator/pricing.py shape)
// ---------------------------------------------------------------------------
// pricing.py calculate_bill_cost: energy_cents = round(kwh*rate), daily_cents =
// round(days*c_per_day), subtotal = energy+daily, then apply_discount. The
// capture's annual_cost is GST-INCLUSIVE (×1.15). These cross-checks prove the
// ×100 unit conversion + levy inclusion + blend are correct, within rounding.
// ---------------------------------------------------------------------------
describe('unit parity vs captured annual_cost', () => {
  it('single-rate 161277 → (0.288+0.0019)×7008 + 1.8×365, ×1.15 ≈ $3092', () => {
    const parsed = parseRscResults(rsc_results_flight);
    if (parsed.status !== 'ok') return;
    const plan = parsed.results.plans.find((p) => p.id === '161277')!;
    const m = mapPowerswitchPlan(plan)!;
    expect(m.plan.c_per_kwh).toBe(28.99); // (0.288 + 0.0019) × 100
    expect(m.plan.c_per_day).toBe(180);

    const kwh = 7008; // the plan block's annual_usage
    const days = 365;
    const subtotal = Math.round(kwh * (m.plan.c_per_kwh as number))
      + Math.round(days * (m.plan.c_per_day as number));
    const withGst = Math.round(subtotal * 1.15); // cents, GST-inclusive
    // Captured annual_cost = $3092 = 309200 cents. Within ±$2.
    expect(Math.abs(withGst - 309200)).toBeLessThanOrEqual(200);
  });

  it('clean TOU blend (PK 0.3567, OP 0.321, F 1.8) → within $1 of the precise blend', () => {
    const tou = mkPlan('tou', 'Clean TOU', 'Electric Kiwi', [
      mkTariff('F', 1.8, 'F'),
      mkTariff('D1', 0.3567, 'PK'),
      mkTariff('N1', 0.321, 'OP'),
    ]);
    const m = mapPowerswitchPlan(tou)!;
    const kwh = 10000;
    const days = 365;
    const mappedTotal = Math.round(kwh * (m.plan.c_per_kwh as number))
      + Math.round(days * (m.plan.c_per_day as number));
    // Precise blend in cents: (0.3567×0.7 + 0.321×0.3)×100×kwh + 180×days.
    const preciseCpkwh = (0.3567 * 0.7 + 0.321 * 0.3) * 100;
    const preciseTotal = Math.round(kwh * preciseCpkwh) + Math.round(days * 180);
    // Rounding the blended rate to 2dp (34.60 vs 34.599) moves ≤ ~$1 at 10000 kWh.
    expect(Math.abs(mappedTotal - preciseTotal)).toBeLessThanOrEqual(100);
  });
});
