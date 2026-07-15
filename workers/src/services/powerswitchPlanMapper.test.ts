import { describe, it, expect } from 'vitest';
import {
  mapPowerswitchPlan,
  mapPowerswitchPlans,
  tariffContentHash,
} from './powerswitchPlanMapper';
import { parseRscResults } from './powerswitchRscParser';
import { rsc_results_flight } from './powerswitchFixtures';
import type { ParsedPlan, ParsedTariff } from './powerswitchRscParser';

/**
 * Issue #222 — Powerswitch tariff → comparator plan mapper. Tests the mapping
 * rules (F/PK/OFFPEAK/TD3/low-user/fixed-term) and parity with the Python
 * comparator's pricing model for the cases it handles.
 */

// Helper: build a ParsedPlan from tariffs without standing up the full flight.
function mkPlan(
  id: string,
  name: string,
  retailerId: string,
  tariffs: ParsedTariff[],
  opts: { fixedTerm?: boolean; priceChangeDue?: string | null } = {}
): ParsedPlan {
  return {
    id,
    name,
    retailerId,
    energyType: 'electricity',
    fixedTerm: opts.fixedTerm ?? false,
    priceChangeDue: opts.priceChangeDue ?? null,
    tariffs,
  };
}

function mkTariff(
  code: string,
  value: number,
  register: string,
  displayType: 'amount' | 'percentage' = 'amount',
  description = ''
): ParsedTariff {
  return {
    code,
    name: code,
    value,
    valueArray: Array.from({ length: 12 }, () => value),
    displayType,
    registerContentCode: register,
    description,
    pricesLastChanged: '2026-01-01',
  };
}

describe('mapPowerswitchPlan — single-rate plan', () => {
  const openVar = mkPlan('plan_mercury_open_var', 'Open Variable', 'mercury', [
    mkTariff('F', 2.30, 'PK', 'amount', 'Daily fixed charge'),
    mkTariff('D1', 29.1, 'PK', 'amount', 'All-day usage'),
  ]);

  it('maps F tariff → c_per_day (cents/day)', () => {
    const m = mapPowerswitchPlan(openVar)!;
    // $2.30/day → 230 cents/day
    expect(m.plan.c_per_day).toBe(230);
  });

  it('maps the PK amount tariff → c_per_kwh', () => {
    const m = mapPowerswitchPlan(openVar)!;
    expect(m.plan.c_per_kwh).toBe(29.1);
  });

  it('does NOT mark a single-rate plan as TOU', () => {
    const m = mapPowerswitchPlan(openVar)!;
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.is_tou).toBeUndefined();
  });

  it('carries fixed_term + price_change_due into conditions', () => {
    const plan = mkPlan(
      'p1', 'Term Plan', 'ret',
      [mkTariff('F', 2.0, 'PK'), mkTariff('D1', 30.0, 'PK')],
      { fixedTerm: true, priceChangeDue: '2026-12-01' }
    );
    const m = mapPowerswitchPlan(plan)!;
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.fixed_term).toBe(true);
    expect(conditions.price_change_due).toBe('2026-12-01');
    expect(conditions.source).toBe('powerswitch_user');
  });

  it('has an empty caveat for a plain single-rate plan', () => {
    const m = mapPowerswitchPlan(openVar)!;
    expect(m.caveat).toBe('');
  });
});

describe('mapPowerswitchPlan — TOU plan (OFFPEAK register)', () => {
  const goodNights = mkPlan('plan_contact_good_nights', 'Good Nights', 'contact', [
    mkTariff('F', 2.10, 'PK'),
    mkTariff('N1', 18.5, 'OFFPEAK', 'amount', 'TOU night 21:00-07:00'),
    mkTariff('D1', 31.2, 'PK', 'amount', 'TOU day 07:00-21:00'),
  ]);

  it('flags is_tou=true when an OFFPEAK register exists', () => {
    const m = mapPowerswitchPlan(goodNights)!;
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.is_tou).toBe(true);
  });

  it('uses the PK (day/peak) tariff as c_per_kwh', () => {
    const m = mapPowerswitchPlan(goodNights)!;
    expect(m.plan.c_per_kwh).toBe(31.2);
  });

  it('carries a TOU caveat', () => {
    const m = mapPowerswitchPlan(goodNights)!;
    expect(m.caveat).toContain('TOU');
  });
});

describe('mapPowerswitchPlan — percentage (TD3) discount', () => {
  const flick = mkPlan('plan_flick_le', 'Flick LE', 'flick', [
    mkTariff('F', 2.50, 'PK'),
    mkTariff('TD3', -12, 'FREE', 'percentage', 'Controlled load, % off'),
  ]);

  it('models the % off as a prompt_payment_discount', () => {
    const m = mapPowerswitchPlan(flick)!;
    expect(m.plan.prompt_payment_discount).toBe(12);
  });

  it('carries a modelled-discount caveat (not a guaranteed rate)', () => {
    const m = mapPowerswitchPlan(flick)!;
    expect(m.caveat).toContain('modelled');
    expect(m.caveat).toContain('not a guaranteed rate');
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.modelled_discount_note).toContain('12%');
  });

  it('does NOT treat a positive percentage (surcharge) as a discount', () => {
    const plan = mkPlan('p2', 'Surcharge Plan', 'ret', [
      mkTariff('F', 2.0, 'PK'),
      mkTariff('TD3', 5, 'FREE', 'percentage'),
    ]);
    const m = mapPowerswitchPlan(plan)!;
    expect(m.plan.prompt_payment_discount).toBeUndefined();
  });
});

describe('mapPowerswitchPlan — low-user variant', () => {
  it('marks low_user_eligible=true when the name contains "low user"', () => {
    const plan = mkPlan('p3', 'Go Low User', 'nova', [
      mkTariff('F', 0.70, 'PK'),
      mkTariff('D1', 36.4, 'PK'),
    ]);
    const m = mapPowerswitchPlan(plan)!;
    expect(m.plan.low_user_eligible).toBe(true);
  });

  it('leaves low_user_eligible=false for standard plans', () => {
    const plan = mkPlan('p4', 'Standard Plan', 'ret', [
      mkTariff('F', 2.0, 'PK'),
      mkTariff('D1', 30.0, 'PK'),
    ]);
    const m = mapPowerswitchPlan(plan)!;
    expect(m.plan.low_user_eligible).toBe(false);
  });
});

describe('mapPowerswitchPlan — unpriceable plans', () => {
  it('returns null when a plan has neither a rate nor a daily charge', () => {
    const plan = mkPlan('p5', 'Weird Plan', 'ret', [
      mkTariff('TD3', -10, 'FREE', 'percentage'),
    ]);
    expect(mapPowerswitchPlan(plan)).toBeNull();
  });
});

describe('mapPowerswitchPlans — full fixture set', () => {
  it('maps the 3-plan fixture (one single-rate, one TOU, one % discount)', () => {
    const parsed = parseRscResults(rsc_results_flight);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;

    const { plans, caveats } = mapPowerswitchPlans(parsed.results.plans);
    expect(plans).toHaveLength(3);

    const names = plans.map((m) => m.plan.name);
    expect(names).toEqual(['Open Variable', 'Good Nights', 'Flick LE']);

    // Caveats cover TOU + modelled discount.
    expect(caveats).toContain('TOU');
    expect(caveats).toContain('modelled');
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
// Parity check vs Python comparator (python/comparator/pricing.py)
// ---------------------------------------------------------------------------
// The Python engine's `calculate_bill_cost(kwh, days, plan)` computes:
//   energy_cents = round(kwh * effective_rate)
//   daily_cents  = round(days * c_per_day)
//   subtotal = energy + daily
//   if prompt_payment_discount > 0: subtotal = round(subtotal * (1 - pct/100))
//
// For a single-rate plan with F + D1 + a % discount, the mapped plan shape
// feeds the same math. This test reconstructs the expected value in-test and
// confirms the mapped fields carry the right units.
// ---------------------------------------------------------------------------
describe('parity with Python comparator (pricing.py calculate_bill_cost)', () => {
  it('a single-rate plan maps to fields that price identically to a seeded plan', () => {
    // Open Variable: F=2.30 $/day (→230 c/day), D1=29.1 c/kWh, no discount.
    const parsed = parseRscResults(rsc_results_flight);
    if (parsed.status !== 'ok') return;
    const openVar = parsed.results.plans.find((p) => p.name === 'Open Variable')!;
    const m = mapPowerswitchPlan(openVar)!;

    // Mirror pricing.py: a 30-day, 600 kWh month.
    const kwh = 600;
    const days = 30;
    const expectedEnergy = Math.round(kwh * (m.plan.c_per_kwh as number));
    const expectedDaily = Math.round(days * (m.plan.c_per_day as number));
    const expectedTotal = expectedEnergy + expectedDaily;

    // A seeded plan with the same c_per_kwh/c_per_day would compute identically.
    const seededEquivalent = { c_per_kwh: 29.1, c_per_day: 230 };
    const seededEnergy = Math.round(kwh * seededEquivalent.c_per_kwh);
    const seededDaily = Math.round(days * seededEquivalent.c_per_day);
    expect(expectedTotal).toBe(seededEnergy + seededDaily);
    expect(expectedTotal).toBe(17460 + 6900); // 24360 cents
  });

  it('a % discount plan applies prompt_payment_discount the same way Python does', () => {
    // Flick LE: F=2.50 $/day (→250 c/day), TD3=-12% → prompt_payment_discount=12.
    const parsed = parseRscResults(rsc_results_flight);
    if (parsed.status !== 'ok') return;
    const flick = parsed.results.plans.find((p) => p.name === 'Flick LE')!;
    const m = mapPowerswitchPlan(flick)!;

    // Mirror pricing.py apply_discount: round(subtotal * (1 - pct/100)).
    const days = 30;
    // Flick LE has no D1/PK amount tariff — c_per_kwh is undefined. The plan is
    // only priceable on its daily charge + the discount. Confirm the discount
    // modelling matches Python's formula.
    const subtotal = Math.round(days * (m.plan.c_per_day as number));
    const pct = m.plan.prompt_payment_discount as number;
    const pythonDiscounted = Math.round(subtotal * (1 - pct / 100));

    const manualDiscounted = Math.round(7500 * 0.88);
    expect(pythonDiscounted).toBe(manualDiscounted); // 6600
  });

  it('a TOU plan is flagged is_tou so Python flags it unsupported (not mispriced)', () => {
    // pricing.py is_unsupported_plan returns True when conditions.is_tou is truthy.
    // The mapper MUST set is_tou for OFFPEAK plans so the Python engine does not
    // flat-price them (which would fake a saving). This is the parity contract.
    const parsed = parseRscResults(rsc_results_flight);
    if (parsed.status !== 'ok') return;
    const goodNights = parsed.results.plans.find((p) => p.name === 'Good Nights')!;
    const m = mapPowerswitchPlan(goodNights)!;
    const conditions = JSON.parse(m.plan.conditions_json as string);
    expect(conditions.is_tou).toBe(true);
    // Mirror pricing.py's check: a TOU plan is unsupported.
    const unsupported = Boolean(conditions.is_tou);
    expect(unsupported).toBe(true);
  });
});
