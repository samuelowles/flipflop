import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sentAuth, validateSentSignature } from './sentAuth';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

describe('sentAuth middleware', () => {
  const TEST_SECRET = 'test-webhook-secret-key-32bytes!!';

  // Helper: create a valid HMAC-SHA256 hex signature for a body
  async function createSignature(body: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    return bytesToHex(new Uint8Array(sig));
  }

  // Test matrix: valid, bad sig, missing header, replay, body manipulation.
  it('accepts requests with valid signature (valid)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const body = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const sig = await createSignature(body, TEST_SECRET);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('rejects requests with invalid signature (bad sig)', async () => {
    const app = new Hono();
    app.use(async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        'X-Sent-Signature': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('rejects requests with no signature header (missing header)', async () => {
    const app = new Hono();
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('unauthorized');
    expect(body.error).toBe('Missing webhook signature');
  });

  it('rejects replayed signature for a different request body (replay)', async () => {
    // Replay = a previously-valid signature being reused. Since HMAC binds the
    // signature to the body, replaying a valid sig with a *different* body must
    // fail. This guards against replay-with-mutation attacks.
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const originalBody = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const replayedBody = JSON.stringify({ from: '+64211234567', body: 'replayed' });
    const sig = await createSignature(originalBody, TEST_SECRET);

    const res = await app.request('/test', {
      method: 'POST',
      body: replayedBody,
      headers: { 'X-Sent-Signature': sig },
    });

    expect(res.status).toBe(401);
  });

  it('rejects tampered body with valid signature for original body (body manipulation)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const originalBody = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const tamperedBody = JSON.stringify({ from: '+64211234567', body: 'malicious' });
    const sig = await createSignature(originalBody, TEST_SECRET);

    const res = await app.request('/test', {
      method: 'POST',
      body: tamperedBody,
      headers: { 'X-Sent-Signature': sig },
    });

    expect(res.status).toBe(401);
  });
});

describe('validateSentSignature (standalone helper)', () => {
  it('validates a correct HMAC-SHA256 signature', async () => {
    const secret = 'test-secret-for-validation';
    const body = 'test body content';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature(body, signature, secret);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect hex signature', async () => {
    const valid = await validateSentSignature(
      'test body',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'test-secret'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature for different body', async () => {
    const secret = 'test-secret-for-validation';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode('original body')
    );
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature('tampered body', signature, secret);
    expect(valid).toBe(false);
  });
});
