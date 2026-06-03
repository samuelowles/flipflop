// Intent taxonomy from DeepSeek classification
export type Intent =
  | 'help'
  | 'usage'
  | 'bill'
  | 'compare'
  | 'switch'
  | 'confirm_switch'
  | 'decline'
  | 'status'
  | 'stop'
  | 'unknown';

// Conversation states (KV-backed state machine)
export type ConversationState =
  | 'NEW'
  | 'ONBOARDING'
  | 'ACTIVE'
  | 'AWAITING_BILL'
  | 'AWAITING_SWITCH_CONFIRM'
  | 'SWITCHING'
  | 'INACTIVE'
  | 'UNSUBSCRIBED';

export type SubscriptionTier = 'free' | 'paid';

export interface IntentClassification {
  readonly intent: Intent;
  readonly confidence: number;
  readonly entities: Readonly<Record<string, unknown>>;
  readonly needsDisambiguation: boolean;
}

export interface StateTransition {
  readonly from: ConversationState;
  readonly to: ConversationState;
  readonly message: string;
}
