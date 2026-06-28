const SENT_API_BASE = 'https://api.sent.dm/v1';

interface SentMessageResponse {
  readonly id: string;
  readonly channel: 'whatsapp' | 'sms';
}

// Typed error classes for Sent API failures so callers (route handlers,
// notification engine) can react distinctly: retry on 429/5xx, hard-fail on
// 401, surface 4xx to logs without alerting ops.
export class SentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SentError';
  }
}

export class SentAuthError extends SentError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'SentAuthError';
  }
}

export class SentRateLimitError extends SentError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'SentRateLimitError';
  }
}

export class SentClientError extends SentError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'SentClientError';
  }
}

export class SentServerError extends SentError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'SentServerError';
  }
}

function mapSentError(status: number, errorText: string): SentError {
  const message = `Sent API error (${status}): ${errorText}`;
  if (status === 401 || status === 403) return new SentAuthError(message);
  if (status === 429) return new SentRateLimitError(message);
  if (status >= 500) return new SentServerError(message, status);
  return new SentClientError(message, status);
}

export type SentChannel = 'whatsapp' | 'sms';

export interface SentSendResult {
  readonly messageId: string;
  readonly channel: SentChannel;
}

export async function sendText(
  apiKey: string,
  to: string,
  body: string,
  channel?: SentChannel
): Promise<SentSendResult> {
  const response = await fetch(`${SENT_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to,
      body,
      ...(channel ? { channel } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw mapSentError(response.status, errorText);
  }

  const data = (await response.json()) as SentMessageResponse;

  console.log(JSON.stringify({
    type: 'sent_message',
    message_id: data.id,
    channel: data.channel,
    timestamp: new Date().toISOString(),
    // Never log phone number or message body
  }));

  return { messageId: data.id, channel: data.channel };
}

export async function sendTemplate(
  apiKey: string,
  to: string,
  templateName: string,
  variables: Record<string, string>
): Promise<SentSendResult> {
  const response = await fetch(`${SENT_API_BASE}/messages/template`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to,
      template_name: templateName,
      variables,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw mapSentError(response.status, errorText);
  }

  const data = (await response.json()) as SentMessageResponse;

  console.log(JSON.stringify({
    type: 'sent_template',
    message_id: data.id,
    template: templateName,
    timestamp: new Date().toISOString(),
  }));

  return { messageId: data.id, channel: data.channel };
}

export async function downloadMedia(
  apiKey: string,
  mediaUrl: string
): Promise<ArrayBuffer> {
  const response = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw mapSentError(response.status, errorText);
  }

  return response.arrayBuffer();
}

// validateSentSignature is in middleware/sentAuth.ts — import from there instead.
