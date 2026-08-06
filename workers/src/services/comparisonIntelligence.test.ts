import { describe, it, expect } from 'vitest';
import { displayablePlanName, GENERIC_PLAN_NAME, explainComparison } from './comparisonIntelligence';


describe('displayablePlanName — the "Unknown" sentinel must not reach copy', () => {
  /**
   * Both real bills in `example bills/` parse to plan_name: "Unknown" — NZ bills
   * mostly do not state a plan name. The sentinel is the DEFAULT, so it landing
   * in a sentence is the default outcome, not an edge case.
   */
  it.each(['Unknown', 'unknown', 'UNKNOWN', '', '   ', null, undefined])(
    'falls back to the generic phrase for %p',
    (input) => {
      expect(displayablePlanName(input)).toBe(GENERIC_PLAN_NAME);
    }
  );

  it('passes a real plan name through unchanged', () => {
    expect(displayablePlanName('MoveMaster')).toBe('MoveMaster');
  });

  it('trims surrounding whitespace from a real name', () => {
    expect(displayablePlanName('  Low User  ')).toBe('Low User');
  });
});

describe('stay-put copy reads correctly without a known plan name', () => {
  const ctx = {
    bestPlanName: 'Best Plan',
    bestRetailerName: 'Contact',
    savingDollarsPerYear: 0,
    currentPlanName: GENERIC_PLAN_NAME,
    currentAnnualCostDollars: 4491,
    stayWhereYouAre: true,
    confidence: 0.9,
    billCount: 1,
  };

  it('drops the parenthetical rather than repeating itself', async () => {
    const msg = await explainComparison(ctx);
    // The unconditional parenthetical produced "Your current plan (your current plan)".
    expect(msg).not.toContain('(your current plan)');
    expect(msg).toContain('Your current plan would cost about $4491/year');
  });

  it('still names the plan when one is known', async () => {
    const msg = await explainComparison({ ...ctx, currentPlanName: 'MoveMaster' });
    expect(msg).toContain('Your current plan (MoveMaster) would cost');
  });
});
