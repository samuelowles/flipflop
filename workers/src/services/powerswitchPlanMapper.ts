/**
 * #222 — Map parsed Powerswitch tariff rows → the comparator's plan shape.
 *
 * Consumes the `ParsedPlan` set produced by #221's RSC parser (read from the
 * per-user KV cache `powerswitch:results:{userId}`) and turns each plan into a
 * `ComparisonPlan` dict that the Python comparator (`/compare`) understands.
 *
 * The mapping is deliberately faithful to what Powerswitch returns — it does NOT
 * invent rates. Where Powerswitch's data model diverges from the comparator's
 * flat-rate assumption (TOU windows, "assumed % power free" discounts), the
 * mapper carries the truth forward via `conditions_json` and caveats:
 *
 *   - Fixed charge (`code:F`, register `PK`) → `c_per_day` ($/day → cents/day).
 *   - Any-time / peak energy (`D1`/`N1`-ish with register `PK`, `display_type=amount`)
 *     → `c_per_kwh` (the peak/standard rate).
 *   - Off-peak / TOU night register (`register_content_code=OFFPEAK`) → marks the
 *     plan as TOU (`conditions_json.is_tou = true`). The comparator's pricing.py
 *     flags TOU plans UNSUPPORTED rather than mispricing them at a flat rate;
 *     this preserves parity with the Python engine's honest "cannot price TOU
 *     without window split" behaviour.
 *   - Percentage tariffs (`display_type=percentage`, e.g. `TD3` "assumed % power
 *     free") → modelled as a `prompt_payment_discount`-style discount ONLY when
 *     the percentage is a positive off value. These are MODELLED ASSUMPTIONS, not
 *     guaranteed rates — the caveat is carried into the plan's
 *     `conditions_json.modelled_discount_note` so the recommendation reason can
 *     surface it ("assumed X% free — modelled, not guaranteed").
 *   - `fixed_term` + `price_change_due` → `conditions_json.fixed_term` /
 *     `conditions_json.price_change_due`.
 *
 * Low-user vs standard-user: Powerswitch surfaces plan variants; the mapper does
 * NOT classify low-user eligibility itself (the comparator derives that from
 * usage + `low_user_eligible`). A plan whose name contains "low user" is marked
 * `low_user_eligible: true`; otherwise it stays standard.
 *
 * Parity with the Python comparator (python/comparator/pricing.py):
 *   - For flat-rate + daily-charge + prompt-payment-discount plans, the mapped
 *     shape feeds `calculate_bill_cost` identically to a seeded plan row.
 *   - For TOU plans, `conditions_json.is_tou = true` makes the Python engine
 *     flag the plan unsupported — the same outcome as a seeded TOU plan. No
 *     silent mispricing.
 */

import type { ParsedPlan } from './powerswitchRscParser';
import type { ComparisonPlan } from '../types/comparison';

/**
 * Conditions surfaced to the Python comparator + the recommendation reason.
 * Mirrors the keys pricing.py reads (`is_tou`, `rate_type`).
 */
export interface PowerswitchPlanConditions {
  /** True when the plan has an OFFPEAK (TOU) register. pricing.py flags TOU unsupported. */
  readonly is_tou?: boolean;
  /** Carried so the recommendation reason can caveat modelled discounts. */
  readonly modelled_discount_note?: string;
  /** True for fixed-term plans (contract). */
  readonly fixed_term?: boolean;
  /** ISO date when a price change is due, if announced. */
  readonly price_change_due?: string | null;
  /** Source provenance tag for the comparison path. */
  readonly source?: string;
}

/** A mapped plan ready for the comparator + a human-readable caveat string. */
export interface MappedPowerswitchPlan {
  /** The comparator plan dict (snake_cased for Python). */
  readonly plan: ComparisonPlan;
  /** Caveat text for the recommendation reason (empty when none applies). */
  readonly caveat: string;
}

/** DOLLAR→cents multiplier. Powerswitch F charge is in $/day. */
const DOLLAR_TO_CENTS = 100;

/**
 * Map a single parsed Powerswitch plan into the comparator's plan shape.
 *
 * Returns `null` when the plan has NO usable rate (neither a flat energy rate
 * nor a fixed charge) — such a plan cannot be priced and is dropped rather than
 * sent to the comparator as a zero-cost bogus alternative.
 */
export function mapPowerswitchPlan(parsed: ParsedPlan): MappedPowerswitchPlan | null {
  const fixedTariff = parsed.tariffs.find((t) => t.code === 'F');
  const amountTariffs = parsed.tariffs.filter(
    (t) => t.displayType === 'amount' && t.code !== 'F'
  );

  // c_per_day: the F tariff is $/day. Convert to cents/day.
  const cPerDay = fixedTariff ? Math.round(fixedTariff.value * DOLLAR_TO_CENTS * 100) / 100 : undefined;

  // Detect TOU: any amount tariff on an OFFPEAK register means time-of-use.
  const hasOffpeak = amountTariffs.some((t) => t.registerContentCode.toUpperCase() === 'OFFPEAK');

  // c_per_kwh: the peak / standard register (PK) amount tariff. When a plan is
  // pure single-rate (only a PK amount tariff, no OFFPEAK), this is the flat
  // rate. For TOU plans the PK rate is the day/peak rate — but the plan is
  // flagged is_tou so the comparator does not flat-price it.
  const peakTariff = amountTariffs.find((t) => t.registerContentCode.toUpperCase() === 'PK')
    ?? amountTariffs[0];
  const cPerKwh = peakTariff ? peakTariff.value : undefined;

  // Percentage tariffs (e.g. TD3 "assumed % power free"). These are MODELLED
  // discounts, not guaranteed rates. Powerswitch encodes them as negative
  // percentages off (e.g. -12 = 12% off). A positive percentage would be a
  // surcharge — we do not model those as discounts.
  const pctTariffs = parsed.tariffs.filter((t) => t.displayType === 'percentage');
  const discountPct = pctTariffs.reduce((sum, t) => {
    // value is negative for "off" (e.g. -12); abs() gives the discount magnitude.
    const off = t.value < 0 ? Math.abs(t.value) : 0;
    return sum + off;
  }, 0);

  // A plan with neither a rate nor a daily charge cannot be priced.
  if (cPerKwh === undefined && cPerDay === undefined) {
    return null;
  }

  const caveats: string[] = [];

  // Build the conditions object with optional fields (the interface is readonly,
  // so assemble it in one pass rather than mutating).
  const conditions: PowerswitchPlanConditions = {
    source: 'powerswitch_user',
    fixed_term: parsed.fixedTerm,
    price_change_due: parsed.priceChangeDue,
    ...(hasOffpeak
      ? { is_tou: true as const }
      : {}),
    ...(discountPct > 0
      ? {
          modelled_discount_note:
            `assumed ${discountPct}% free (modelled discount, not a guaranteed rate)`,
        }
      : {}),
  };

  if (hasOffpeak) {
    caveats.push('TOU plan: priced as unsupported (window split not modelled)');
  }

  if (discountPct > 0) {
    // Modelled as a prompt-payment-style discount on the subtotal. This is an
    // ASSUMPTION — Powerswitch's "assumed % power free" is a questionnaire-based
    // estimate of controlled-load usage, not a contractual rate. Carry the
    // caveat so notification copy can be honest.
    caveats.push(conditions.modelled_discount_note!);
  }

  const lowUserEligible = /\blow\s*user\b/i.test(parsed.name);

  const plan: ComparisonPlan = {
    id: parsed.id,
    retailer_id: parsed.retailerId,
    name: parsed.name,
    c_per_kwh: cPerKwh,
    c_per_day: cPerDay,
    // prompt_payment_discount is the comparator's discount hook (pricing.py
    // applies it to the subtotal). We model the % free discount through it.
    prompt_payment_discount: discountPct > 0 ? discountPct : undefined,
    conditions_json: JSON.stringify(conditions),
    low_user_eligible: lowUserEligible,
  };

  return { plan, caveat: caveats.join('; ') };
}

/**
 * Map a full parsed plan set → comparator plan dicts. Plans that cannot be
 * priced (no rate + no daily charge) are dropped. Returns the mapped plans plus
 * the combined caveat string for the recommendation reason.
 *
 * @param plans parsed plans from the #221 KV cache
 * @returns mapped plans (non-empty if at least one plan priced) + caveats
 */
export function mapPowerswitchPlans(
  plans: ReadonlyArray<ParsedPlan>
): { readonly plans: readonly MappedPowerswitchPlan[]; readonly caveats: string } {
  const mapped: MappedPowerswitchPlan[] = [];
  for (const p of plans) {
    const m = mapPowerswitchPlan(p);
    if (m) mapped.push(m);
  }
  // De-duplicate caveats so the reason stays concise.
  const uniqueCaveats = [...new Set(mapped.map((m) => m.caveat).filter(Boolean))];
  return { plans: mapped, caveats: uniqueCaveats.join(' | ') };
}

/** Re-export for the comparison-path service to compute a plan-set content hash. */
export function tariffContentHash(parsed: ParsedPlan): string {
  // Lightweight deterministic hash of the tariff lines for the provenance row's
  // raw_hash. Not cryptographic — just an idempotency fingerprint.
  const sig = parsed.tariffs
    .map((t) => `${t.code}:${t.registerContentCode}:${t.value}:${t.displayType}`)
    .join('|');
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (Math.imul(31, h) + sig.charCodeAt(i)) | 0;
  }
  return `ps_${(h >>> 0).toString(16)}`;
}
