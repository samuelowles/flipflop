export type BillStatus = 'pending_parse' | 'parsing' | 'parsed' | 'needs_review';
export type BillSource = 'whatsapp' | 'sms' | 'gmail' | 'outlook' | 'web';
export type MeterType = 'standard' | 'low_user' | 'day_night' | 'controlled';

export interface Bill {
  readonly id: string;
  readonly userId: string;
  readonly retailerId: string | null;
  readonly planName: string | null;
  readonly meterType: MeterType | null;
  readonly periodStart: string | null; // ISO 8601
  readonly periodEnd: string | null; // ISO 8601
  readonly days: number | null;
  readonly usageKwh: number | null;
  readonly totalCents: number | null; // integer cents NZD
  readonly cPerKwh: number | null;
  readonly cPerDay: number | null;
  readonly fixedTermExpiry: string | null; // ISO 8601
  readonly breakFeeCents: number | null;
  readonly status: BillStatus;
  readonly confidence: number | null;
  readonly rawR2Key: string | null;
  readonly parsedJson: string | null;
  readonly source: BillSource | null;
  readonly createdAt: string; // ISO 8601
}

export interface CreateBillInput {
  readonly userId: string;
  readonly rawR2Key: string;
  readonly source?: BillSource;
  readonly retailerId?: string;
}

export interface UpdateBillParsedData {
  readonly retailerId?: string;
  readonly planName?: string;
  readonly meterType?: MeterType;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly days?: number;
  readonly usageKwh?: number;
  readonly totalCents?: number;
  readonly cPerKwh?: number;
  readonly cPerDay?: number;
  readonly fixedTermExpiry?: string | null;
  readonly breakFeeCents?: number;
  readonly confidence?: number;
  readonly parsedJson?: string;
  readonly status: 'parsed' | 'needs_review';
}
