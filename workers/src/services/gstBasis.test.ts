import { describe, it, expect } from 'vitest';
import { detectRatesGstInclusive } from './gstBasis';

/**
 * The two fixtures below are the REAL bills in `example bills/`, parsed by the
 * Python generic parser. They are the whole reason this module exists: two NZ
 * retailers, opposite GST conventions, neither stating which.
 */

/** Electric Kiwi — "Rate (incl GST)": 43.71 c/kWh, $1.10/day, $140.36 total. */
const ELECTRIC_KIWI = {
  usageKwh: 298.49,
  cPerKwh: 43.71,
  days: 9,
  cPerDay: 110.0,
  totalCents: 14036,
};

/** Mercury — ex-GST table: 22.49 c/kWh, 291 c/day, subtotal $343.63 + GST. */
const MERCURY = {
  usageKwh: 1113.88,
  cPerKwh: 22.49,
  days: 32,
  cPerDay: 291.0,
  totalCents: 39518,
};

describe('detectRatesGstInclusive', () => {
  it('detects Electric Kiwi rates as GST-inclusive', () => {
    expect(detectRatesGstInclusive(ELECTRIC_KIWI)).toBe(true);
  });

  it('detects Mercury rates as GST-exclusive', () => {
    expect(detectRatesGstInclusive(MERCURY)).toBe(false);
  });

  it('separates the two bases by far more than the tolerance', () => {
    // Guards the tolerance choice: if these ever converge the detector is
    // guessing, and a wrong guess is a 15% error in the saving we quote.
    const lineItems = MERCURY.usageKwh * MERCURY.cPerKwh + MERCURY.days * MERCURY.cPerDay;
    const inclusiveError = Math.abs(lineItems - MERCURY.totalCents) / MERCURY.totalCents;
    expect(inclusiveError).toBeGreaterThan(0.1);
  });

  it.each([
    ['usageKwh', { ...MERCURY, usageKwh: null }],
    ['cPerKwh', { ...MERCURY, cPerKwh: null }],
    ['days', { ...MERCURY, days: null }],
    ['cPerDay', { ...MERCURY, cPerDay: null }],
    ['totalCents', { ...MERCURY, totalCents: null }],
  ])('returns undefined when %s is missing', (_field, bill) => {
    expect(detectRatesGstInclusive(bill)).toBeUndefined();
  });

  it('returns undefined for a zero total rather than guessing', () => {
    expect(detectRatesGstInclusive({ ...MERCURY, totalCents: 0 })).toBeUndefined();
  });

  it('returns undefined when the figures fit neither basis (mis-parse)', () => {
    // A total that is neither the line items nor the line items + GST means at
    // least one field was extracted wrong; declaring a basis would launder a
    // bad parse into a confident comparison.
    expect(detectRatesGstInclusive({ ...MERCURY, totalCents: 99_999 })).toBeUndefined();
  });
});
