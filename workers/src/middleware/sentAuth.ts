import type { Context, Next } from 'hono';

// Sent sends a signature in the X-Sent-Signature header
// We validate it using HMAC-SHA256 (hex-encoded) over the raw body, compared
// in constant time via the Web Crypto verify operation.

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): BufferSource {
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

  const rawBody = await c.req.raw.clone().text();
  const secret = c.env.SENT_WEBHOOK_SECRET as string;

  // HMAC-SHA256 over raw body, hex-encoded. crypto.subtle.verify is constant-time.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sigBytes = hexToBytes(signature);
  const dataBytes = encoder.encode(rawBody);

  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);

  if (!valid) {
    logAuthFailure(c, 'invalid_signature');
    return c.json(
      { error: 'Invalid webhook signature', code: 'unauthorized', status: 401 },
      401
    );
  }

  // Extract phone from body for downstream rate limiting (per-user keying)
  try {
    const body = JSON.parse(rawBody) as { from?: string };
    if (body.from) {
      c.set('phone', body.from);
    }
  } catch {
    // Body parsing failed — rate limiter will fall back to IP
  }

  await next();
}

// Helper: validate signature without Hono context (for unit testing)
export async function validateSentSignature(
  rawBody: string,
  signature: string,
  secret: string
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
  const dataBytes = encoder.encode(rawBody);
  return crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);
}
