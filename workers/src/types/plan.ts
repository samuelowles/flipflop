export type PlanSource = 'eiep14a' | 'manual';

export interface Plan {
  readonly id: string;
  readonly retailerId: string;
  readonly name: string;
  readonly region: string | null;
  readonly cPerKwh: number | null;
  readonly cPerDay: number | null;
  readonly tierThresholdsJson: string | null;
  readonly promptPaymentDiscount: number | null;
  readonly conditionsJson: string | null;
  readonly lowUserEligible: boolean;
  readonly source: PlanSource;
  readonly eiep14aId: string | null;
  readonly effectiveFrom: string | null; // ISO 8601
  readonly effectiveTo: string | null; // ISO 8601
}
