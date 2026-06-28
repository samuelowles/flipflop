import type { Context, Next } from 'hono';
import { generatePhoneHash } from '../models/encryption';

// Sent sends a signature in the X-Sent-Signature header
// We validate it using HMAC-SHA256 (hex-encoded) over the raw body, compared
// in constant time via the Web Crypto verify operation.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): BufferSource {
  // SHA-256 hex digests are exactly 64 hex chars (32 bytes); reject anything
  // else before allocating the output buffer.
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('invalid hex length or characters');
  }
  const len = hex.length / 2;
  const out = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function logAuthFailure(c: Context, reason: string): void {
  // Structured log with request_id for correlation; never include body, headers,
  // or signature material (no PII / no secret leakage).
  console.log(JSON.stringify({
    level: 'warn',
    type: 'sent_auth_failed',
    request_id: c.get('request_id') ?? crypto.randomUUID(),
    reason,
    path: c.req.path,
    method: c.req.method,
    timestamp: new Date().toISOString(),
  }));
}

export async function sentAuth(c: Context, next: Next): Promise<Response | void> {
  const signature = c.req.header('X-Sent-Signature');
  if (!signature) {
    logAuthFailure(c, 'missing_signature');
    return c.json(
      { error: 'Missing webhook signature', code: 'unauthorized', status: 401 },
      401
    );
  }

  // Replay-window guard: Sent (sent.dm) webhooks include X-Sent-Timestamp as a
  // Unix-seconds string. HMAC is computed over `${timestamp}.${rawBody}` and
  // we reject anything older than 5 minutes to bound replay attacks.
  const ts = c.req.header('X-Sent-Timestamp');
  if (!ts || !/^\d{10}$/.test(ts)) {
    logAuthFailure(c, 'missing_or_malformed_timestamp');
    return c.json(
      { error: 'Missing or malformed timestamp', code: 'unauthorized', status: 401 },
      401
    );
  }
  const drift = Math.abs(Date.now() / 1000 - Number(ts));
  if (drift > 300) {
    logAuthFailure(c, 'timestamp_outside_window');
    return c.json(
      { error: 'Stale webhook timestamp', code: 'unauthorized', status: 401 },
      401
    );
  }

  const rawBody = await c.req.raw.clone().text();
  const env = c.env as { SENT_WEBHOOK_SECRET?: string } | undefined;
  const secret = env?.SENT_WEBHOOK_SECRET;
  if (!secret || secret.length === 0) {
    console.error(JSON.stringify({ level: 'error', type: 'sent_auth_misconfigured' }));
    return c.json(
      { error: 'Authentication misconfigured', code: 'misconfigured', status: 500 },
      500
    );
  }

  // HMAC-SHA256 over `${timestamp}.${rawBody}`, hex-encoded. crypto.subtle.verify
  // is constant-time. The timestamp is bound to the signature so the same
  // signature cannot be replayed with a fresh timestamp.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  let sigBytes: BufferSource;
  try {
    sigBytes = hexToBytes(signature);
  } catch {
    logAuthFailure(c, 'malformed_signature_hex');
    return c.json(
      { error: 'Malformed webhook signature', code: 'unauthorized', status: 401 },
      401
    );
  }
  const dataBytes = encoder.encode(`${ts}.${rawBody}`);

  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);

  if (!valid) {
    logAuthFailure(c, 'invalid_signature');
    return c.json(
      { error: 'Invalid webhook signature', code: 'unauthorized', status: 401 },
      401
    );
  }

  // Extract phone from body for downstream rate limiting (per-user keying).
  // Store the SHA-256 hash, not the raw phone, to minimise PII retention. The
  // raw phone is also kept as `phone` for backward compatibility with PR #151's
  // rate limit middleware; remove once #151 lands.
  try {
    const body = JSON.parse(rawBody) as { from?: string };
    if (body.from) {
      const phoneHash = await generatePhoneHash(body.from);
      c.set('phone_hash', phoneHash);
      c.set('phone', body.from);
    }
  } catch {
    // Body parsing failed — rate limiter will fall back to IP
  }

  await next();
}

// Helper: validate signature without Hono context (for unit testing).
// The `timestamp` arg is required because the signature binds the body to a
// specific Unix-seconds timestamp; tests must provide it explicitly.
export async function validateSentSignature(
  rawBody: string,
  signature: string,
  secret: string,
  timestamp: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = hexToBytes(signature);
  const dataBytes = encoder.encode(`${timestamp}.${rawBody}`);
  return crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);
}
