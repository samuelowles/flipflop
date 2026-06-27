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

  // Helper: create a valid HMAC-SHA256 hex signature for `${ts}.${body}`.
  // Mirrors Sent (sent.dm) signing convention; the timestamp is bound into
  // the HMAC payload so the same signature cannot be replayed with a fresh ts.
  async function createSignature(
    body: string,
    secret: string,
    timestamp: string
  ): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${timestamp}.${body}`)
    );
    return bytesToHex(new Uint8Array(sig));
  }

  // Fresh timestamp (now) for happy-path tests.
  const nowTs = () => Math.floor(Date.now() / 1000).toString();

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
    const ts = nowTs();
    const sig = await createSignature(body, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
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
        'X-Sent-Timestamp': nowTs(),
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
    // signature to the body+timestamp, replaying a valid sig with a *different*
    // body must fail. This guards against replay-with-mutation attacks.
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const ts = nowTs();
    const originalBody = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const replayedBody = JSON.stringify({ from: '+64211234567', body: 'replayed' });
    const sig = await createSignature(originalBody, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body: replayedBody,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
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

    const ts = nowTs();
    const originalBody = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const tamperedBody = JSON.stringify({ from: '+64211234567', body: 'malicious' });
    const sig = await createSignature(originalBody, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body: tamperedBody,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
    });

    expect(res.status).toBe(401);
  });

  // ---- HIGH — replay window ----
  it('rejects timestamps older than 5 minutes (stale replay window)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const body = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const staleTs = (Math.floor(Date.now() / 1000) - 301).toString(); // 301s ago
    const sig = await createSignature(body, TEST_SECRET, staleTs);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': staleTs },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe('unauthorized');
    expect(json.error).toBe('Stale webhook timestamp');
  });

  it('accepts timestamps within the 5-minute window', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const body = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const ts = (Math.floor(Date.now() / 1000) - 60).toString(); // 60s ago
    const sig = await createSignature(body, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
    });

    expect(res.status).toBe(200);
  });

  it('rejects malformed timestamps (non-numeric or wrong length)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    // 13-char timestamp (milliseconds, not seconds) is malformed per the
    // /^\d{10}$/ contract.
    const malformedTs = Date.now().toString();
    const body = JSON.stringify({ test: true });
    const sig = await createSignature(body, TEST_SECRET, malformedTs);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': malformedTs },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('unauthorized');
  });

  // ---- MEDIUM — hex validation ----
  it('rejects signatures with invalid hex length (too short)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        // 10 chars instead of 64 — would have crashed on parseInt NaN pre-fix.
        'X-Sent-Signature': 'deadbeefde',
        'X-Sent-Timestamp': nowTs(),
      },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe('unauthorized');
    expect(json.error).toBe('Malformed webhook signature');
  });

  it('rejects signatures with non-hex characters (correct length, bad chars)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    // 64 chars but contains 'z' and 'g' — invalid hex.
    const badHex = 'z'.repeat(32) + 'g'.repeat(32);

    const res = await app.request('/test', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        'X-Sent-Signature': badHex,
        'X-Sent-Timestamp': nowTs(),
      },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe('unauthorized');
    expect(json.error).toBe('Malformed webhook signature');
  });

  // ---- MEDIUM — PII hashing ----
  it('stores phone_hash (SHA-256) in context instead of raw phone', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as Record<string, unknown>).env = {};
      (c.env as Record<string, string>).SENT_WEBHOOK_SECRET = TEST_SECRET;
      await next();
    });

    let capturedPhoneHash: string | undefined;
    let capturedPhone: string | undefined;
    app.post('/test', sentAuth, (c) => {
      capturedPhoneHash = (c.get as (k: string) => unknown).call(c, 'phone_hash') as string | undefined;
      capturedPhone = (c.get as (k: string) => unknown).call(c, 'phone') as string | undefined;
      return c.json({ ok: true });
    });

    const body = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const ts = nowTs();
    const sig = await createSignature(body, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
    });

    expect(res.status).toBe(200);
    expect(capturedPhoneHash).toBeDefined();
    expect(capturedPhoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedPhoneHash).not.toBe('+64211234567');
    // Backward-compat alias kept while PR #151 lands; raw phone still present.
    expect(capturedPhone).toBe('+64211234567');
  });

  // ---- MEDIUM — env null check ----
  it('returns 500 when SENT_WEBHOOK_SECRET is missing', async () => {
    const app = new Hono();
    // Intentionally do NOT inject SENT_WEBHOOK_SECRET into c.env.
    app.post('/test', sentAuth, (c) => c.json({ ok: true }));

    const body = JSON.stringify({ from: '+64211234567', body: 'hello' });
    const ts = nowTs();
    const sig = await createSignature(body, TEST_SECRET, ts);

    const res = await app.request('/test', {
      method: 'POST',
      body,
      headers: { 'X-Sent-Signature': sig, 'X-Sent-Timestamp': ts },
    });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('misconfigured');
  });
});

describe('validateSentSignature (standalone helper)', () => {
  it('validates a correct HMAC-SHA256 signature with timestamp binding', async () => {
    const secret = 'test-secret-for-validation';
    const body = 'test body content';
    const ts = '1700000000';

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
      encoder.encode(`${ts}.${body}`)
    );
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature(body, signature, secret, ts);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect hex signature', async () => {
    const valid = await validateSentSignature(
      'test body',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'test-secret',
      '1700000000'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature for different body', async () => {
    const secret = 'test-secret-for-validation';
    const ts = '1700000000';

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
      encoder.encode(`${ts}.original body`)
    );
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature('tampered body', signature, secret, ts);
    expect(valid).toBe(false);
  });
});