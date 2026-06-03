import type { Context, Next } from 'hono';

// Sent sends a signature in the X-Sent-Signature header
// We validate it using HMAC-SHA256 with the SENT_WEBHOOK_SECRET

export async function sentAuth(c: Context, next: Next): Promise<Response | void> {
  const signature = c.req.header('X-Sent-Signature');
  if (!signature) {
    return c.json(
      { error: 'Missing webhook signature', code: 'unauthorized', status: 401 },
      401
    );
  }

  const rawBody = await c.req.raw.clone().text();
  const secret = c.env.SENT_WEBHOOK_SECRET as string;

  // HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  const dataBytes = encoder.encode(rawBody);

  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);

  if (!valid) {
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
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  const dataBytes = encoder.encode(rawBody);
  return crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);
}
