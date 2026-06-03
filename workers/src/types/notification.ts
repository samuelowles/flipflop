export type NotificationType = 'saving_alert' | 'stay_put' | 'fixed_term_expiry' | 'free_tier_checkin' | 'switch_update';

export interface Notification {
  readonly id: string;
  readonly userId: string;
  readonly type: NotificationType;
  readonly contentJson: string | null;
  readonly sentAt: string; // ISO 8601
  readonly respondedAt: string | null; // ISO 8601
  readonly response: string | null;
}
