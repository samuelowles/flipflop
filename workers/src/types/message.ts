import type { Intent } from './conversation';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageChannel = 'whatsapp' | 'sms';

export interface Message {
  readonly id: string;
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly channel: MessageChannel;
  readonly body: string | null;
  readonly mediaUrl: string | null;
  readonly sentMessageId: string | null;
  readonly intent: Intent | null;
  readonly createdAt: string; // ISO 8601
}
