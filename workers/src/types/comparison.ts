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
}
