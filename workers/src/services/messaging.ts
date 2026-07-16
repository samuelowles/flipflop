import { env as workerEnv } from 'cloudflare:workers';
import type { EncryptionEnv } from '../models/encryption';
import { createMessage } from '../models/messages';

// #242 testing: optionally override the Sent API origin (e.g. a local mock for
// end-to-end runs without real WhatsApp sends). Unset in production → real API.
const SENT_API_BASE =
  ((workerEnv as { SENT_API_BASE_URL?: string }).SENT_API_BASE_URL ?? 'https://api.sent.dm/v1');

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

// Channel routing (issue #23): WhatsApp first, SMS fallback on transient
// failure. Retry policy: max 1 WhatsApp retry on 429/5xx, then SMS; if SMS
// also fails the final error is thrown. 401/403/other 4xx are not retried —
// they fall through immediately to SMS because a bad API key or invalid
// payload won't recover.
export interface SentFallbackResult extends SentSendResult {
  readonly fallback: boolean;
  readonly whatsappAttempts: number;
}

const MAX_WHATSAPP_ATTEMPTS = 2;

function shouldRetry(err: unknown): boolean {
  return err instanceof SentRateLimitError || err instanceof SentServerError;
}

function logFallback(params: {
  apiKey: string;
  reason: string;
  whatsappAttempts: number;
  finalChannel: SentChannel;
}): Promise<void> {
  // Structured log — observability for the "Sent dashboard shows fallback
  // rate" AC clause. Hash the key (not the API secret) so we can attribute
  // fallbacks per-integration without leaking the secret itself.
  return logFallbackAsync(params);
}

async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, '0');
  return hex.slice(0, 12);
}

// Deduplicate fingerprint computation across the two fallback calls in one
// invocation (we'd otherwise hash twice for the failed-then-succeeded path).
async function logFallbackAsync(params: {
  apiKey: string;
  reason: string;
  whatsappAttempts: number;
  finalChannel: SentChannel;
  apiKeyFingerprint?: string;
}): Promise<void> {
  const fingerprint = params.apiKeyFingerprint ?? await hashApiKey(params.apiKey);
  console.log(JSON.stringify({
    type: 'sent_fallback',
    reason: params.reason,
    whatsapp_attempts: params.whatsappAttempts,
    final_channel: params.finalChannel,
    api_key_fingerprint: fingerprint,
    timestamp: new Date().toISOString(),
  }));
}

export async function sendWithFallback(
  apiKey: string,
  to: string,
  body: string
): Promise<SentFallbackResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_WHATSAPP_ATTEMPTS; attempt++) {
    try {
      const result = await sendText(apiKey, to, body, 'whatsapp');
      return { ...result, fallback: false, whatsappAttempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) break;
      if (attempt < MAX_WHATSAPP_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  try {
    const smsResult = await sendText(apiKey, to, body, 'sms');
    await logFallback({
      apiKey,
      reason: lastErr instanceof Error ? lastErr.message : 'unknown',
      whatsappAttempts: MAX_WHATSAPP_ATTEMPTS,
      finalChannel: 'sms',
    });
    return { ...smsResult, fallback: true, whatsappAttempts: MAX_WHATSAPP_ATTEMPTS };
  } catch (smsErr) {
    await logFallback({
      apiKey,
      reason: `whatsapp_and_sms_failed: ${smsErr instanceof Error ? smsErr.message : 'unknown'}`,
      whatsappAttempts: MAX_WHATSAPP_ATTEMPTS,
      finalChannel: 'sms',
    });
    throw smsErr;
  }
}

// Outbound message logger (issue #30): wraps sendWithFallback and writes
// a row to the messages table. Channel + sent_message_id come from the
// Sent response; channel is the one that actually delivered (whatsapp or
// sms after fallback).
export async function sendAndLog(
  apiKey: string,
  db: D1Database,
  env: EncryptionEnv,
  userId: string,
  to: string,
  body: string
): Promise<SentFallbackResult> {
  const result = await sendWithFallback(apiKey, to, body);
  await createMessage(db, env, {
    userId,
    direction: 'outbound',
    channel: result.channel,
    body,
    sentMessageId: result.messageId,
  });
  return result;
}

export async function sendTemplateWithFallback(
  apiKey: string,
  to: string,
  templateName: string,
  variables: Record<string, string>
): Promise<SentFallbackResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_WHATSAPP_ATTEMPTS; attempt++) {
    try {
      const result = await sendTemplate(apiKey, to, templateName, variables);
      return { ...result, fallback: false, whatsappAttempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) break;
      if (attempt < MAX_WHATSAPP_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  try {
    const smsResult = await sendTemplate(apiKey, to, templateName, variables);
    await logFallback({
      apiKey,
      reason: lastErr instanceof Error ? lastErr.message : 'unknown',
      whatsappAttempts: MAX_WHATSAPP_ATTEMPTS,
      finalChannel: 'sms',
    });
    return { ...smsResult, fallback: true, whatsappAttempts: MAX_WHATSAPP_ATTEMPTS };
  } catch (smsErr) {
    await logFallback({
      apiKey,
      reason: `whatsapp_and_sms_failed: ${smsErr instanceof Error ? smsErr.message : 'unknown'}`,
      whatsappAttempts: MAX_WHATSAPP_ATTEMPTS,
      finalChannel: 'sms',
    });
    throw smsErr;
  }
}

// validateSentSignature is in middleware/sentAuth.ts — import from there instead.
