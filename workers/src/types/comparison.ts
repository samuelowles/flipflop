export interface PlanComparison {
  readonly id: string;
  readonly userId: string;
  readonly planId: string;
  readonly billIdsJson: string | null;
  readonly projectedCostCents: number; // integer cents NZD
  readonly currentCostCents: number; // integer cents NZD
  readonly savingCents: number; // negative = saving, positive = more expensive
  readonly confidence: number;
  readonly comparedAt: string; // ISO 8601
  // --- AC #73 summary fields (nullable: legacy rows + runs with no verdict) ---
  readonly billId?: string | null; // bill that triggered this run
  readonly currentPlanId?: string | null; // user's plan at compare time
  readonly recommendedPlanId?: string | null; // top switchable plan, or current when stay_put
  readonly projectedAnnualCost?: number | null; // integer cents NZD, recommended plan
  readonly savings?: number | null; // integer cents NZD, signed (positive = saving)
  readonly recommendation?: Recommendation | null; // 'switch' | 'stay_put'
  readonly reason?: RecommendationReason | null; // present on stay_put
  readonly computedAt?: string | null; // ISO 8601 — verdict timestamp
}

// ---------------------------------------------------------------------------
// Python comparator boundary contract (Issue #123)
// These types mirror the shape produced by python/comparator/plan_comparator.py.
// TypeScript owns schema/validation only — no plan-cost math crosses here.
// ---------------------------------------------------------------------------

export interface ComparisonUsageProfile {
  readonly avgDailyKwh: number;
  readonly meterType: string;
  readonly seasonalWeights: { readonly summer: number; readonly winter: number };
}

export interface ComparisonBillSummary {
  readonly id: string;
  readonly usageKwh: number;
  readonly totalCents: number;
  readonly periodStart: string; // ISO 8601
  readonly periodEnd: string; // ISO 8601
  readonly days: number;
  readonly breakFeeCents?: number;
}

export interface ComparisonPlan {
  readonly id?: string;
  readonly retailer_id: string;
  readonly name?: string;
  readonly region?: string;
  readonly c_per_kwh?: number;
  readonly c_per_day?: number;
  readonly tier_thresholds_json?: string;
  readonly prompt_payment_discount?: number;
  readonly conditions_json?: string;
  readonly low_user_eligible?: number | boolean;
  [key: string]: unknown;
}

export interface ComparisonCurrentPlan extends ComparisonPlan {
  readonly plan_name?: string;
  readonly break_fee_cents?: number;
  readonly fixed_term_expiry?: string; // ISO 8601
}

export interface ComparisonInput {
  readonly usageProfile: ComparisonUsageProfile;
  readonly currentPlan: ComparisonCurrentPlan;
  readonly availablePlans: readonly ComparisonPlan[];
  readonly billHistory: readonly ComparisonBillSummary[];
}

export type Recommendation = 'switch' | 'stay_put';

// Reasons the AC (#72) names. recent_switch is applied TS-side after a DB read;
// the others come from Python's money-derived verdict.
export type RecommendationReason =
  | 'no_savings'
  | 'low_savings'
  | 'contract_constraints'
  | 'lock_in_too_high'
  | 'recent_switch';

export interface ComparisonResultItem {
  readonly plan_id: string;
  readonly plan_name: string;
  readonly retailer_id: string;
  readonly projected_cost_cents: number;
  readonly current_cost_cents: number;
  readonly saving_cents: number; // positive = saving (Python convention)
  readonly confidence: number;
  readonly stay_where_you_are: boolean;
  readonly comparison_details: string;
  readonly break_fee_warning?: boolean;
  readonly net_first_year_saving_cents?: number;
  readonly fixed_term_expiry?: string;
  readonly unsupported?: boolean;
  readonly unsupported_reason?: string;
  readonly recommendation?: Recommendation; // user-level verdict, stamped on every item (AC #72)
  readonly reason?: RecommendationReason | null; // present when recommendation === 'stay_put'
}

export type ComparisonResult = readonly ComparisonResultItem[];
