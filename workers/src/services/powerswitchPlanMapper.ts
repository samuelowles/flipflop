/**
 * #222/#240 — Map parsed Powerswitch tariff rows → the comparator's plan shape.
 *
 * Consumes the `ParsedPlan` set from #221's RSC parser and turns each into a
 * `ComparisonPlan` dict the Python comparator understands. Rebuilt against the
 * REAL capture (workers/tests/fixtures/powerswitch-live/18-results.res.txt).
 *
 * UNIT CORRECTION (#240): tariff `value` is in $/kWh EX-GST (e.g. 0.288), and
 * the F charge is $/day. The comparator works in CENTS. So every rate is
 * multiplied by 100 here. The earlier build treated value as cents and was off
 * by 100×. Cross-checked against the capture: 161277 (IN 0.288 + EC 0.0019,
 * F 1.8) → (0.288+0.0019)×7008 + 1.8×365 = $2688.6, ×1.15 GST = $3091.9 ≈ the
 * captured annual_cost of $3092. ✓
 *
 * TOU CORRECTION (#240): the real off-peak register_content_code is `OP`, not
 * OFFPEAK. TOU plans (PK + OP/SH) are BLENDED into a single c_per_kwh using an
 * assumed peak/off-peak usage split, and are NOT flagged is_tou — pricing.py
 * (is_unsupported_plan) would otherwise drop them. The blend is a calibration
 * knob (peak_share), not a measured value; it is carried in conditions_json so
 * the recommendation reason can caveat it.
 *
 * TD3 ("assumed % power free") is a positive percentage FRACTION (0.2685 =
 * 26.85%). Modelled as prompt_payment_discount = value×100 — an assumption, not
 * a guaranteed rate; caveat carried into conditions_json + the reason.
 */

import type { ParsedPlan, ParsedTariff } from './powerswitchRscParser';
import type { ComparisonPlan } from '../types/comparison';

/** $→cents. Powerswitch rates are $/kWh and $/day; the comparator is in cents. */
const DOLLAR_TO_CENTS = 100;

/**
 * Assumed share of annual usage falling in the peak window. The remainder is
 * spread evenly across the off-peak/shoulder registers. A calibration knob —
 * real splits vary by household; tuning this retunes every TOU blend. ponytail:
 * single global, per-plan shares if a household profile ever warrants it.
 */
const PEAK_SHARE = 0.7;

/** Conditions surfaced to the Python comparator + the recommendation reason. */
export interface PowerswitchPlanConditions {
  readonly source: 'powerswitch_user';
  readonly fixed_term: boolean;
  readonly price_change_due: boolean | string;
  /** 'tou' when peak+off-peak registers were blended; 'flat' otherwise. */
  readonly register_type?: 'tou' | 'flat';
  /** The peak share used by the blend (present only for TOU). */
  readonly peak_share?: number;
  /** Carried so the recommendation reason can caveat modelled discounts. */
  readonly modelled_discount_note?: string;
}

/** A mapped plan ready for the comparator + a human-readable caveat string. */
export interface MappedPowerswitchPlan {
  /** The comparator plan dict (snake_cased for Python). */
  readonly plan: ComparisonPlan;
  /** Caveat text for the recommendation reason (empty when none applies). */
  readonly caveat: string;
}

/** Per-kWh levies (Electricity Authority Levy etc.) — added to the energy rate. */
const LEVY_CODES = new Set(['EC', 'ED']);
/** Single-rate (any-time) energy registers. */
const FLAT_CODES = new Set(['IN', 'UN']);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Map a single parsed Powerswitch plan into the comparator's plan shape.
 * Returns `null` when the plan has no usable rate AND no fixed charge — it
 * cannot be priced and is dropped rather than sent as a zero-cost bogus option.
 */
export function mapPowerswitchPlan(parsed: ParsedPlan): MappedPowerswitchPlan | null {
  const tariffs = parsed.tariffs;

  // Fixed daily charge: the F tariff, $/day → cents/day.
  const fixedTariff = tariffs.find((t) => t.code === 'F' && t.displayType === 'amount');
  const cPerDay = fixedTariff ? round2(fixedTariff.value * DOLLAR_TO_CENTS) : undefined;

  // Partition the amount registers (excluding F) by role.
  const amountTariffs = tariffs.filter((t) => t.displayType === 'amount' && t.code !== 'F');
  const peak = amountTariffs.find((t) => t.registerContentCode === 'PK');
  // Off-peak: OP, or an empty register_content_code when a peak is present
  // (180418 "Flex Low Use" keys off-peak on register "").
  const offpeak = amountTariffs.filter(
    (t) => t.registerContentCode === 'OP' || (peak && t.registerContentCode === '' && t.value > 0)
  );
  const shoulder = amountTariffs.filter((t) => t.registerContentCode === 'SH');
  const flat = amountTariffs.filter((t) => FLAT_CODES.has(t.registerContentCode));
  const levies = amountTariffs.filter((t) => LEVY_CODES.has(t.registerContentCode));
  const levySum = levies.reduce((s, t) => s + t.value, 0);

  // Blend a single $/kWh rate. TOU when a peak coexists with off-peak/shoulder.
  const isTou = !!peak && (offpeak.length > 0 || shoulder.length > 0);
  let cPerKwh: number | undefined;
  if (isTou && peak) {
    const offReg = [...offpeak, ...shoulder];
    const offAvg = offReg.length > 0 ? offReg.reduce((s, t) => s + t.value, 0) / offReg.length : 0;
    const blended = peak.value * PEAK_SHARE + offAvg * (1 - PEAK_SHARE) + levySum;
    cPerKwh = round2(blended * DOLLAR_TO_CENTS);
  } else if (flat.length > 0) {
    // Single-rate: sum the any-time registers (+ levies), $/kWh → cents/kWh.
    const flatSum = flat.reduce((s, t) => s + t.value, 0) + levySum;
    cPerKwh = round2(flatSum * DOLLAR_TO_CENTS);
  } else if (peak) {
    // Peak-only (no off-peak) — treat the peak rate as the flat rate.
    cPerKwh = round2((peak.value + levySum) * DOLLAR_TO_CENTS);
  }

  // A plan with neither a rate nor a daily charge cannot be priced.
  if (cPerKwh === undefined && cPerDay === undefined) {
    return null;
  }

  // Percentage tariffs: TD3 "assumed % power free" is a POSITIVE fraction
  // (0.2685 = 26.85%). PP/ED discounts show value 0 here. Model positive
  // percentages as a prompt-payment-style subtotal discount — an assumption.
  const pctTariffs = tariffs.filter((t) => t.displayType === 'percentage' && t.value > 0);
  const discountPct = round2(pctTariffs.reduce((s, t) => s + t.value, 0) * 100);

  const caveats: string[] = [];
  const conditions: PowerswitchPlanConditions = {
    source: 'powerswitch_user',
    fixed_term: parsed.fixedTerm,
    price_change_due: parsed.priceChangeDue,
    ...(isTou
      ? { register_type: 'tou' as const, peak_share: PEAK_SHARE }
      : { register_type: 'flat' as const }),
    ...(discountPct > 0
      ? { modelled_discount_note: `assumed ${discountPct}% power free (modelled, not guaranteed)` }
      : {}),
  };

  if (isTou) {
    caveats.push(
      `TOU plan priced via assumed ${Math.round(PEAK_SHARE * 100)}/${Math.round((1 - PEAK_SHARE) * 100)} peak/off-peak split (modelled, not guaranteed)`
    );
  }
  if (discountPct > 0) {
    caveats.push(conditions.modelled_discount_note!);
  }

  const lowUserEligible = /\blow\s*user\b/i.test(parsed.name);

  const plan: ComparisonPlan = {
    id: parsed.id,
    retailer_id: parsed.retailerId,
    name: parsed.name,
    c_per_kwh: cPerKwh,
    c_per_day: cPerDay,
    // pricing.py applies prompt_payment_discount to the subtotal.
    prompt_payment_discount: discountPct > 0 ? discountPct : undefined,
    conditions_json: JSON.stringify(conditions),
    low_user_eligible: lowUserEligible,
  };

  return { plan, caveat: caveats.join('; ') };
}

/**
 * Map a full parsed plan set → comparator plan dicts. Plans that cannot be
 * priced (no rate + no daily charge) are dropped. Returns the mapped plans plus
 * the de-duplicated caveat string for the recommendation reason.
 */
export function mapPowerswitchPlans(
  plans: ReadonlyArray<ParsedPlan>
): { readonly plans: readonly MappedPowerswitchPlan[]; readonly caveats: string } {
  const mapped: MappedPowerswitchPlan[] = [];
  for (const p of plans) {
    const m = mapPowerswitchPlan(p);
    if (m) mapped.push(m);
  }
  const uniqueCaveats = [...new Set(mapped.map((m) => m.caveat).filter(Boolean))];
  return { plans: mapped, caveats: uniqueCaveats.join(' | ') };
}

/** Deterministic content hash of a plan's tariff set (provenance raw_hash). */
export function tariffContentHash(parsed: ParsedPlan): string {
  const sig = parsed.tariffs
    .map((t: ParsedTariff) => `${t.code}:${t.registerContentCode}:${t.value}:${t.displayType}`)
    .join('|');
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (Math.imul(31, h) + sig.charCodeAt(i)) | 0;
  }
  return `ps_${(h >>> 0).toString(16)}`;
}
