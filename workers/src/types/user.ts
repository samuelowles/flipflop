import type { ConversationState, SubscriptionTier } from './conversation';

export interface User {
  readonly id: string;
  readonly phone: string; // encrypted at rest
  readonly sentContactId: string | null;
  readonly name: string | null; // encrypted at rest
  readonly email: string | null; // encrypted at rest
  readonly subscriptionTier: SubscriptionTier;
  readonly stripeCustomerId: string | null;
  readonly currentRetailerId: string | null;
  readonly currentPlanName: string | null;
  readonly icpNumber: string | null; // encrypted at rest
  readonly installationAddress: string | null; // encrypted at rest
  readonly notificationThresholdCents: number; // integer cents NZD
  readonly state: ConversationState;
  readonly createdAt: string; // ISO 8601
  readonly updatedAt: string; // ISO 8601
}

export type CreateUserInput = Pick<User, 'phone'> & Partial<Pick<User, 'name' | 'sentContactId'>>;

export type UpdateUserInput = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;
