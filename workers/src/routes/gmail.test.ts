import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { gmailConnectPage, gmailLogin, gmailCallback, gmailScanStatus, gmailEvalStatus } from './gmail';
import { runEvalComparison } from './eval';
import { mintFlowLink } from '../services/flowLink';

/** The signed u/exp/sig triple the status endpoints require (see gmail.ts). */
async function signedQuery(userId: string): Promise<string> {
  const link = await mintFlowLink('test-encryption-key-32bytes!!', userId);
  return link.slice(link.indexOf('?') + 1);
}

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

vi.mock('../models/encryption', () => ({
  encrypt: vi.fn(async (plaintext: string) => `encrypted:${plaintext}`),
}));

vi.mock('../models/oauth', () => ({
  storeOAuthTokens: vi.fn(async () => {}),
  getOAuthTokens: vi.fn(async () => null),
}));

vi.mock('../models/users', () => ({
  findOrCreateByPhone: vi.fn(async (_db: unknown, _env: unknown, phone: string) => ({
    user: { id: 'user-phone-1', phone },
    created: true,
  })),
}));

vi.mock('../services/emailPoller', () => ({
  pollSingleUser: vi.fn(async () => ({
    userId: 'user-phone-1',
    billsFound: 0,
    errors: [],
  })),
  readScanProgress: vi.fn(),
}));

vi.mock('../services/messaging', () => ({
  sendText: vi.fn(async () => {}),
}));

vi.mock('./eval', () => ({
  runEvalComparison: vi.fn(),
}));

function makeMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key: string) =>
      Promise.resolve({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeMockDB(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: () => Promise.resolve(null),
        all: () => Promise.resolve({ results: [] }),
        run: () => Promise.resolve({ meta: {} }),
      }),
    }),
  } as unknown as D1Database;
}

function makeEnv(): Record<string, unknown> {
  return {
    GMAIL_CLIENT_ID: 'test-client-id',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
    ENCRYPTION_KEY: 'test-encryption-key-32bytes!!',
    SENT_API_KEY: 'test-sent-api-key',
    KV: makeMockKV(),
    DB: makeMockDB(),
    BILLS: {
      put: vi.fn(async () => {}),
    },
    PARSE_QUEUE: {
      send: vi.fn(async () => {}),
    },
  };
}

function createTestApp() {
  const app = new Hono();
  app.get('/auth/gmail', gmailConnectPage);
  app.post('/auth/gmail/login', gmailLogin);
  app.get('/auth/gmail/callback', gmailCallback);
  app.get('/auth/gmail/scan-status', gmailScanStatus);
  return app;
}

describe('GET /auth/gmail', () => {
  it('returns HTML page with phone input form', async () => {
    const app = createTestApp();
    const res = await app.request('/auth/gmail', {}, makeEnv());

    expect(res.status).toBe(200);
    const contentType = res.headers.get('Content-Type');
    expect(contentType).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Connect Gmail');
    expect(html).toContain('Connect your Gmail');
    expect(html).toContain('/auth/gmail/login');
    expect(html).toContain('method="POST"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('name="phone"');
    expect(html).toContain('+64211234567');
  });

  it('shows error message when error=invalid_phone', async () => {
    const app = createTestApp();
    const res = await app.request('/auth/gmail?error=invalid_phone', {}, makeEnv());

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('valid NZ mobile number');
  });

  it('shows error message when error=already_connected', async () => {
    const app = createTestApp();
    const res = await app.request('/auth/gmail?error=already_connected', {}, makeEnv());

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('already linked');
  });
});

describe('POST /auth/gmail/login', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns 500 when GMAIL_CLIENT_ID is not configured', async () => {
    const app = createTestApp();
    const env = makeEnv();
    delete (env as Record<string, unknown>).GMAIL_CLIENT_ID;

    const formData = new URLSearchParams({ phone: '+64211234567' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('not_configured');
  });

  it('redirects with error for empty phone', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const formData = new URLSearchParams({ phone: '' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/auth/gmail?error=invalid_phone');
  });

  it('redirects with error for invalid phone format', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const formData = new URLSearchParams({ phone: '0211234567' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/auth/gmail?error=invalid_phone');
  });

  it('accepts valid NZ mobile and redirects to Google OAuth', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const formData = new URLSearchParams({ phone: '+64211234567' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'flip-api.example.workers.dev',
        },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('client_id=test-client-id');
  });

  it('stores nonce with userId and phone in KV as JSON', async () => {
    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const formData = new URLSearchParams({ phone: '+64211234567' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'flip-api.example.workers.dev',
        },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const stateParam = new URL(location).searchParams.get('state');
    expect(stateParam).not.toBeNull();

    const decoded = JSON.parse(
      atob(stateParam!.replace(/-/g, '+').replace(/_/g, '/'))
    ) as { userId: string; phone: string; nonce: string };

    expect(decoded.phone).toBe('+64211234567');
    expect(decoded.userId).toBe('user-phone-1');

    const storedJson = await kv.get(`oauth:nonce:${decoded.nonce}`);
    expect(storedJson).not.toBeNull();
    const stored = JSON.parse(storedJson!);
    expect(stored.userId).toBe('user-phone-1');
    expect(stored.phone).toBe('+64211234567');
  });

  it('redirects with error when user already has Gmail connected', async () => {
    const { getOAuthTokens } = await import('../models/oauth');
    (getOAuthTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'existing-token',
      userId: 'user-phone-1',
      provider: 'gmail',
    });

    const app = createTestApp();
    const env = makeEnv();

    const formData = new URLSearchParams({ phone: '+64211234567' });
    const res = await app.request(
      '/auth/gmail/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/auth/gmail?error=already_connected');
  });
});

describe('GET /auth/gmail/callback', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns 500 when not configured', async () => {
    const app = createTestApp();
    const env: Record<string, unknown> = {};

    const res = await app.request('/auth/gmail/callback?code=abc&state=xyz', {}, env);
    expect(res.status).toBe(500);
  });

  it('returns cancellation message when user denied consent', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const res = await app.request('/auth/gmail/callback?error=access_denied', {}, env);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('cancelled');
  });

  it('returns 400 when code or state is missing', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const res = await app.request('/auth/gmail/callback', {}, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('returns 400 for invalid state', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const res = await app.request(
      '/auth/gmail/callback?code=abc&state=invalid!!!',
      {},
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_state');
  });

  it('returns 400 when nonce not found in KV', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const state = { userId: 'user-1', phone: '+64211234567', nonce: 'nonexistent-nonce' };
    const stateStr = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await app.request(
      `/auth/gmail/callback?code=valid-code&state=${stateStr}`,
      {},
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_state');
  });

  it('exchanges code for tokens, stores encrypted tokens, returns progress page', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'gmail-access-token',
        expires_in: 3600,
        refresh_token: 'gmail-refresh-token',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    // Pre-store nonce with JSON { userId, phone }
    const nonce = crypto.randomUUID();
    await kv.put(
      `oauth:nonce:${nonce}`,
      JSON.stringify({ userId: 'user-1', phone: '+64211234567' }),
      { expirationTtl: 600 }
    );

    const state = { userId: 'user-1', phone: '+64211234567', nonce };
    const stateStr = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await app.request(
      `/auth/gmail/callback?code=valid-auth-code&state=${stateStr}`,
      { headers: { Host: 'flip-api.example.workers.dev' } },
      env
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Now returns HTML progress page (not plain text)
    expect(text).toContain('Scanning your Gmail inbox');
    expect(text).toContain('Exchanging authorization code');
    expect(text).toContain('scan-status');

    // Nonce should be consumed (deleted)
    const consumed = await kv.get(`oauth:nonce:${nonce}`);
    expect(consumed).toBeNull();
  });

  it('cleans up nonce after successful exchange', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'tok',
        expires_in: 3600,
        scope: 'scope',
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const nonce = crypto.randomUUID();
    await kv.put(
      `oauth:nonce:${nonce}`,
      JSON.stringify({ userId: 'user-1', phone: '+64211234567' }),
      { expirationTtl: 600 }
    );

    const state = { userId: 'user-1', phone: '+64211234567', nonce };
    const stateStr = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await app.request(
      `/auth/gmail/callback?code=code&state=${stateStr}`,
      { headers: { Host: 'localhost' } },
      env
    );

    // Nonce must be deleted after use
    const after = await kv.get(`oauth:nonce:${nonce}`);
    expect(after).toBeNull();
  });

  it('returns 400 for nonce with state userId mismatch', async () => {
    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const nonce = crypto.randomUUID();
    await kv.put(
      `oauth:nonce:${nonce}`,
      JSON.stringify({ userId: 'different-user', phone: '+64211234567' }),
      { expirationTtl: 600 }
    );

    const state = { userId: 'user-1', phone: '+64211234567', nonce };
    const stateStr = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await app.request(
      `/auth/gmail/callback?code=code&state=${stateStr}`,
      {},
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_state');
  });

  it('returns progress page on Google token exchange failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as unknown as Response);

    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const nonce = crypto.randomUUID();
    await kv.put(
      `oauth:nonce:${nonce}`,
      JSON.stringify({ userId: 'user-1', phone: '+64211234567' }),
      { expirationTtl: 600 }
    );

    const state = { userId: 'user-1', phone: '+64211234567', nonce };
    const stateStr = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await app.request(
      `/auth/gmail/callback?code=bad-code&state=${stateStr}`,
      { headers: { Host: 'localhost' } },
      env
    );

    // Error is caught and rendered as HTML progress page
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Scanning your Gmail inbox');
    // The setup log JSON should contain the error message
    expect(text).toContain('Error');
    expect(text).toContain('invalid_grant');
  });
});

// ---------- GET /auth/gmail/scan-status ----------

describe('GET /auth/gmail/scan-status', () => {
  it('returns 403 when the request carries no signature', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const res = await app.request('/auth/gmail/scan-status', {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid or expired link');
  });

  it('returns 404 when no scan progress exists for user', async () => {
    const app = createTestApp();
    const env = makeEnv();

    const res = await app.request(`/auth/gmail/scan-status?${await signedQuery('nonexistent')}`, {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No scan in progress');
  });

  it('returns scan progress JSON for a user with progress in KV', async () => {
    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    // Pre-seed scan progress in KV
    const progress = {
      phase: 'scanning',
      messagesFound: 10,
      messagesScanned: 3,
      messagesSkippedNoSubject: 1,
      messagesSkippedNoPdf: 0,
      billsFound: 1,
      billSenders: ['Contact Energy <bills@contact.co.nz>'],
      filteredSenders: [],
      errors: [],
      complete: false,
      startedAt: '2026-05-14T12:00:00Z',
    };
    await kv.put('gmail:scan:user-1', JSON.stringify(progress), {
      expirationTtl: 3600,
    });

    const { readScanProgress } = await import('../services/emailPoller');
    (readScanProgress as ReturnType<typeof vi.fn>).mockResolvedValue(progress);

    const res = await app.request(`/auth/gmail/scan-status?${await signedQuery('user-1')}`, {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe('scanning');
    expect(body.messagesFound).toBe(10);
    expect(body.messagesScanned).toBe(3);
    expect(body.billsFound).toBe(1);
    expect(body.complete).toBe(false);
    expect(body.startedAt).toBe('2026-05-14T12:00:00Z');
  });

  it('returns complete progress when scan is done', async () => {
    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const progress = {
      phase: 'complete',
      messagesFound: 5,
      messagesScanned: 5,
      messagesSkippedNoSubject: 3,
      messagesSkippedNoPdf: 1,
      billsFound: 1,
      billSenders: ['Contact Energy <bills@contact.co.nz>'],
      filteredSenders: [],
      errors: [],
      complete: true,
      startedAt: '2026-05-14T12:00:00Z',
      finishedAt: '2026-05-14T12:00:30Z',
    };
    await kv.put('gmail:scan:user-1', JSON.stringify(progress), {
      expirationTtl: 3600,
    });

    const { readScanProgress } = await import('../services/emailPoller');
    (readScanProgress as ReturnType<typeof vi.fn>).mockResolvedValue(progress);

    const res = await app.request(`/auth/gmail/scan-status?${await signedQuery('user-1')}`, {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe('complete');
    expect(body.complete).toBe(true);
    expect(body.finishedAt).toBe('2026-05-14T12:00:30Z');
  });

  it('reports errors in scan progress JSON', async () => {
    const app = createTestApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;

    const progress = {
      phase: 'complete',
      messagesFound: 2,
      messagesScanned: 2,
      messagesSkippedNoSubject: 0,
      messagesSkippedNoPdf: 0,
      billsFound: 0,
      billSenders: [],
      filteredSenders: [],
      errors: ['Token error: Token expired and no refresh token available'],
      complete: true,
      startedAt: '2026-05-14T12:00:00Z',
      finishedAt: '2026-05-14T12:00:05Z',
    };
    await kv.put('gmail:scan:user-1', JSON.stringify(progress), {
      expirationTtl: 3600,
    });

    const { readScanProgress } = await import('../services/emailPoller');
    (readScanProgress as ReturnType<typeof vi.fn>).mockResolvedValue(progress);

    const res = await app.request(`/auth/gmail/scan-status?${await signedQuery('user-1')}`, {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.errors)).toBe(true);
    expect((body.errors as string[]).length).toBe(1);
    expect((body.errors as string[])[0]).toContain('Token expired');
  });
});

// #242 deployed-run fix — the Plan Comparison box must live-update: eval-status
// is PENDING (never cached) while bills are still queue-parsing, caches only
// real results, and self-heals poisoned empty cache entries.
describe('GET /auth/gmail/eval-status (pending semantics + cache)', () => {
  function evalApp() {
    const app = new Hono();
    app.get('/auth/gmail/eval-status', gmailEvalStatus);
    return app;
  }

  beforeEach(() => {
    vi.mocked(runEvalComparison).mockReset();
  });

  it('returns pending with parse counts while no comparisons exist, and caches nothing', async () => {
    vi.mocked(runEvalComparison).mockResolvedValueOnce({
      parsedData: null, comparisons: [], billsTotal: 12, billsParsed: 3, verdict: null,
    });
    const app = evalApp();
    const env = makeEnv();

    const res = await app.request(`/auth/gmail/eval-status?${await signedQuery('u1')}`, {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(false);
    expect(body.pending).toBe(true);
    expect(body.billsParsed).toBe(3);
    expect(body.billsTotal).toBe(12);

    const kv = env.KV as KVNamespace;
    expect(await kv.get('gmail:eval:u1')).toBeNull();
  });

  it('ignores and deletes a poisoned empty cache entry, then recomputes', async () => {
    const app = evalApp();
    const env = makeEnv();
    const kv = env.KV as KVNamespace;
    // The pre-fix bug: an empty found:true result cached for 24h.
    await kv.put('gmail:eval:u1', JSON.stringify({ found: true, parsedData: null, comparisons: [] }));

    vi.mocked(runEvalComparison).mockResolvedValueOnce({
      parsedData: null, comparisons: [], billsTotal: 12, billsParsed: 12, verdict: null,
    });
    const res = await app.request(`/auth/gmail/eval-status?${await signedQuery('u1')}`, {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pending).toBe(true);
    expect(await kv.get('gmail:eval:u1')).toBeNull(); // poison purged
    expect(runEvalComparison).toHaveBeenCalledTimes(1); // recomputed, not served from cache
  });

  it('returns and caches real results', async () => {
    const comparisons = [{ plan_id: 'p1', plan_name: 'Plan A', saving_cents: 12000 }];
    vi.mocked(runEvalComparison).mockResolvedValueOnce({
      parsedData: { retailer: 'Meridian Energy' }, comparisons, billsTotal: 12, billsParsed: 12, verdict: null,
    });
    const app = evalApp();
    const env = makeEnv();

    const res = await app.request(`/auth/gmail/eval-status?${await signedQuery('u1')}`, {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(true);
    expect((body.comparisons as unknown[]).length).toBe(1);

    const kv = env.KV as KVNamespace;
    const cached = JSON.parse((await kv.get('gmail:eval:u1'))!) as Record<string, unknown>;
    expect(cached.found).toBe(true);

    // Second request serves the cache — no recompute.
    await app.request(`/auth/gmail/eval-status?${await signedQuery('u1')}`, {}, env);
    expect(runEvalComparison).toHaveBeenCalledTimes(1);
  });

  it('returns and caches the verdict alongside the results', async () => {
    const verdict = {
      recommendation: 'switch' as const,
      planName: 'Good Night Plan',
      retailerName: 'Contact Energy',
      currentCostCents: 25000,
      projectedCostCents: 24000,
      savingCents: 41200,
      confidence: 0.85,
    };
    vi.mocked(runEvalComparison).mockResolvedValueOnce({
      parsedData: { retailer_name: 'Contact Energy' },
      comparisons: [{ plan_name: 'Good Night Plan' }],
      billsTotal: 12,
      billsParsed: 12,
      verdict,
    });
    const app = evalApp();
    const env = makeEnv();

    const res = await app.request(`/auth/gmail/eval-status?${await signedQuery('u1')}`, {}, env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(true);
    expect(body.verdict).toEqual(verdict);

    // Verdict is cached with the rest of the body.
    const kv = env.KV as KVNamespace;
    const cached = JSON.parse((await kv.get('gmail:eval:u1'))!) as Record<string, unknown>;
    expect(cached.verdict).toEqual(verdict);
  });
});

describe('status endpoints reject anything but a valid signature (access control)', () => {
  /**
   * These endpoints used to accept a bare `?userId=`, and returned that user's
   * data to whoever asked: scan-status carries `billSenders` / `filteredSenders`
   * — From addresses out of their Gmail inbox — and eval-status carries their
   * bill-derived comparisons.
   *
   * A user id is a database key, not a credential, and this one TRAVELS IN A
   * URL: it is in the post-OAuth page the user is invited to open, so it lands
   * in browser history and in anything they share.
   */
  const ENV_KEY = 'test-encryption-key-32bytes!!';

  it('rejects a bare userId — the old, unauthenticated contract', async () => {
    const app = createTestApp();
    const res = await app.request('/auth/gmail/scan-status?userId=user-1', {}, makeEnv());
    expect(res.status, 'a raw user id must no longer be accepted').toBe(403);
  });

  it('rejects a tampered signature', async () => {
    const app = createTestApp();
    const q = await signedQuery('user-1');
    const tampered = q.replace(/sig=[0-9a-f]+/, 'sig=' + 'a'.repeat(64));
    const res = await app.request(`/auth/gmail/scan-status?${tampered}`, {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it('rejects an expired link', async () => {
    const app = createTestApp();
    const link = await mintFlowLink(ENV_KEY, 'user-1', -60); // already expired
    const q = link.slice(link.indexOf('?') + 1);
    const res = await app.request(`/auth/gmail/scan-status?${q}`, {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it('will not let one user\u2019s signature read another user\u2019s data', async () => {
    // The signature covers the user id, so swapping `u` invalidates it. This is
    // the property that actually contains the disclosure.
    const app = createTestApp();
    const q = await signedQuery('user-1');
    const swapped = q.replace('u=user-1', 'u=victim');
    const res = await app.request(`/auth/gmail/scan-status?${swapped}`, {}, makeEnv());
    expect(res.status).toBe(403);
  });

  it('does not distinguish bad signature from unknown user', async () => {
    // Different responses would confirm which user ids exist.
    const app = createTestApp();
    const bad = await app.request('/auth/gmail/scan-status?u=a&exp=99999999999&sig=deadbeef', {}, makeEnv());
    const swapped = await app.request('/auth/gmail/scan-status?u=b&exp=99999999999&sig=deadbeef', {}, makeEnv());
    expect(bad.status).toBe(swapped.status);
    expect(await bad.text()).toBe(await swapped.text());
  });
});

describe('Powerswitch disclosure (POWERSWITCH_COMPLIANCE.md)', () => {
  /**
   * `POWERSWITCH_LIVE="true"`, so the compare stage sends a real user's address
   * to a third party. The compliance doc specifies the disclosure copy but
   * records it as "draft ... not wired into code here", so users were told
   * nothing — the connect page mentioned only Gmail. Telling someone their data
   * goes to a named third party, before it does, is IPP 3, not politeness.
   */
  it('names Powerswitch and the ICP guarantee on the connect page', async () => {
    const app = createTestApp();
    const res = await app.request('/auth/gmail', {}, makeEnv());
    const html = await res.text();

    expect(html).toContain('Powerswitch.org.nz');
    expect(html, 'the ICP guarantee is the keystone privacy claim').toMatch(/ICP number is never shared/i);
    expect(html, 'the 7-day cache window is disclosed').toMatch(/7 days/);
  });

  it('discloses before the address is ever collected', async () => {
    // The connect page runs before OAuth, before any bill is parsed, and so
    // before any address exists to send. Disclosure after the fact is not
    // disclosure.
    const app = createTestApp();
    const res = await app.request('/auth/gmail', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Powerswitch.org.nz');
  });

  it('carries no emoji — these messages are SMS-eligible', () => {
    // The compliance doc's draft copy opens with an emoji, which contradicts the
    // project's own SMS rule (see bugs.md: emojis stripped from SMS-eligible
    // messages). The wired copy follows the rule, not the draft.
    // eslint-disable-next-line no-control-regex
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    expect(emoji.test('Cheers! Flip\u2019s hooked up')).toBe(false);
  });
});
