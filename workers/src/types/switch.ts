export type SwitchStatus = 'requested' | 'confirmed' | 'in_progress' | 'completed' | 'failed';

export interface Switch {
  readonly id: string;
  readonly userId: string;
  readonly fromRetailerId: string;
  readonly toPlanId: string;
  readonly status: SwitchStatus;
  readonly requestedAt: string; // ISO 8601
  readonly confirmedAt: string | null; // ISO 8601
  readonly completedAt: string | null; // ISO 8601
}
