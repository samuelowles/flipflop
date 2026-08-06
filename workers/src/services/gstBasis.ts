/**
 * Which GST basis a bill's unit rates are printed on.
 *
 * NZ retailers use BOTH conventions and no bill field states which:
 *   - Electric Kiwi prints "Rate (incl GST)"  — 43.71 c/kWh includes GST.
 *   - Mercury prints an ex-GST table          — 22.49 c/kWh, GST added below.
 *
 * The comparator prices the current plan from these rates and the candidate
 * plans from Powerswitch tariffs (which are EX-GST). Mixing the two bases
 * inflates an incl-GST customer's current cost by 15%, which is invented
 * saving: on the real Electric Kiwi bill in `example bills/` it turned a
 * true $907/yr saving into a quoted $1,530/yr.
 *
 * No bill field declares the basis, but the bill's own arithmetic does — only
 * one basis reproduces the stated total. This mirrors `reconcile_total` in
 * python/parsers/base.py, which already computes both candidates and keeps the
 * closer one; here we keep WHICH one won.
 */

/** NZ GST rate. */
const GST_RATE = 0.15;

/**
 * Relative error either basis may show and still be accepted. Bills round
 * their line items, so an exact match is not available; 2% is far tighter than
 * the 15% gap between the two bases, so the winner is never ambiguous in
 * practice.
 */
const BASIS_TOLERANCE = 0.02;

/** The bill fields needed to decide the basis. */
export interface GstBasisInput {
  readonly usageKwh: number | null;
  readonly cPerKwh: number | null;
  readonly days: number | null;
  readonly cPerDay: number | null;
  readonly totalCents: number | null;
}

/**
 * Return `true` when the bill's rates already include GST, `false` when GST
 * must be added to them, or `undefined` when the bill does not state enough to
 * decide (or states figures that fit neither basis — a mis-parse).
 *
 * `undefined` is a real answer, not a failure: the caller leaves the basis
 * undeclared and the comparator falls back to treating rates as GST-inclusive,
 * which UNDER-states the current cost and so can only suppress a switch
 * recommendation, never invent one.
 */
export function detectRatesGstInclusive(bill: GstBasisInput): boolean | undefined {
  const { usageKwh, cPerKwh, days, cPerDay, totalCents } = bill;
  if (
    usageKwh == null ||
    cPerKwh == null ||
    days == null ||
    cPerDay == null ||
    totalCents == null ||
    usageKwh <= 0 ||
    cPerKwh <= 0 ||
    days <= 0 ||
    cPerDay <= 0 ||
    totalCents <= 0
  ) {
    return undefined;
  }

  const lineItems = usageKwh * cPerKwh + days * cPerDay;
  if (lineItems <= 0) return undefined;

  // If the rates already include GST, the line items ARE the total.
  const inclusiveError = Math.abs(lineItems - totalCents) / totalCents;
  // If they exclude it, the total is the line items plus GST.
  const exclusiveError = Math.abs(lineItems * (1 + GST_RATE) - totalCents) / totalCents;

  const best = Math.min(inclusiveError, exclusiveError);
  if (best > BASIS_TOLERANCE) return undefined; // fits neither — do not guess

  return inclusiveError <= exclusiveError;
}
