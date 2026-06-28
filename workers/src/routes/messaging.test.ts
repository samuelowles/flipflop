import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { messagingWebhook } from './messaging';
import { sentAuth } from '../middleware/sentAuth';

type StoredUser = Record<string, unknown>;

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const TEST_SECRET = 'test-webhook-secret';

async function signWebhook(body: string, ts: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${body}`));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, '0');
  return hex;
}

function mockDeepSeekResponse(intent: string, confidence: number) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ intent, confidence, entities: {} }) } }],
    }),
  } as unknown as Response;
}

function mockSentResponse(id: string, channel = 'whatsapp') {
  return {
    ok: true,
    json: async () => ({ id, channel }),
  } as unknown as Response;
}

function makeUserRow(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: 'usr-test-001',
    phone: '+6421999888777',
    phone_encrypted: null,
    phone_hash: null,
    sent_contact_id: null,
    name: null,
    email: null,
    subscription_tier: 'free',
    stripe_customer_id: null,
    current_retailer_id: null,
    current_plan_name: null,
    icp_number: null,
    installation_address: null,
    notification_threshold_cents: 500,
    state: 'NEW',
    created_at: '2026-05-14T00:00:00+12:00',
    updated_at: '2026-05-14T00:00:00+12:00',
    ...overrides,
  };
}

function createTestEnv(options: {
  existingPhone?: string;
  existingUserRow?: StoredUser;
  envOverrides?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const usersById = new Map<string, StoredUser>();
  const phoneToUser = new Map<string, StoredUser>();
  const messagesById = new Map<string, Record<string, unknown>>();
  const billsById = new Map<string, Record<string, unknown>>();

  if (options.existingPhone && options.existingUserRow) {
    phoneToUser.set(options.existingPhone, options.existingUserRow);
    usersById.set(options.existingUserRow.id as string, options.existingUserRow);
  }

  function makeStatement(sql: string) {
    const boundArgs: unknown[] = [];

    const stmt = {
      bind: (...args: unknown[]) => { boundArgs.length = 0; boundArgs.push(...args); return stmt; },
      first: <T>(): Promise<T | null> => {
        if (sql.includes('SELECT * FROM users WHERE phone')) {
          return Promise.resolve((phoneToUser.get(boundArgs[0] as string) ?? null) as T | null);
        }
        if (sql.includes('SELECT * FROM users WHERE id')) {
          return Promise.resolve((usersById.get(boundArgs[0] as string) ?? null) as T | null);
        }
        if (sql.includes('SELECT * FROM messages WHERE id')) {
          return Promise.resolve((messagesById.get(boundArgs[0] as string) ?? null) as T | null);
        }
        if (sql.includes('SELECT * FROM bills WHERE id')) {
          return Promise.resolve((billsById.get(boundArgs[0] as string) ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      run: () => {
        if (sql.includes('INSERT INTO users')) {
          const [id, phone, phoneEncrypted, phoneHash, sentContactId, name, created, updated] = boundArgs;
          const row = makeUserRow({
            id: id as string, phone: phone as string,
            phone_encrypted: (phoneEncrypted ?? null) as string | null,
            phone_hash: (phoneHash ?? null) as string | null,
            sent_contact_id: (sentContactId ?? null) as string | null,
            name: (name ?? null) as string | null,
            created_at: created as string, updated_at: updated as string,
          });
          usersById.set(id as string, row);
          phoneToUser.set(phone as string, row);
        }
        if (sql.includes('INSERT INTO messages')) {
          const [id, userId, direction, channel, body, bodyEncrypted, mediaUrl, sentMessageId, intent, created] = boundArgs;
          const row: Record<string, unknown> = {
            id, user_id: userId, direction, channel,
            body: body ?? null, body_encrypted: bodyEncrypted ?? null,
            media_url: mediaUrl ?? null,
            sent_message_id: sentMessageId ?? null, intent: intent ?? null,
            created_at: created,
          };
          messagesById.set(id as string, row);
        }
        if (sql.includes('INSERT INTO bills')) {
          const [id, userId, retailerId, rawR2Key, source, created] = boundArgs;
          const row: Record<string, unknown> = {
            id, user_id: userId, retailer_id: retailerId ?? null,
            raw_r2_key: rawR2Key, source: source ?? null,
            status: 'pending_parse', created_at: created,
          };
          billsById.set(id as string, row);
        }
        return Promise.resolve({ meta: {} });
      },
      all: <T>() => Promise.resolve({ results: [] as T[] }),
    };
    return stmt;
  }

  const mockDB = { prepare: (sql: string) => makeStatement(sql) } as unknown as D1Database;

  const kvStore = new Map<string, string>();
  const mockKV = {
    get: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
    put: (key: string, value: string) => { kvStore.set(key, value); return Promise.resolve(); },
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: (key: string) => Promise.resolve({ value: kvStore.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace;

  const mockBills = { put: () => Promise.resolve({} as R2Object), get: () => Promise.resolve(null) } as unknown as R2Bucket;
  const mockParseQueue = { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() } as unknown as Queue<{ billId: string; r2Key: string }>;

  return {
    SENT_API_KEY: 'test-sent-key',
    SENT_WEBHOOK_SECRET: 'test-webhook-secret',
    DEEPSEEK_API_KEY: 'test-deepseek-key',
    ENCRYPTION_KEY: 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyEhISE=',
    DB: mockDB,
    KV: mockKV,
    BILLS: mockBills,
    PARSE_QUEUE: mockParseQueue,
    ...(options.envOverrides ?? {}),
  };
}

function createTestApp() {
  const app = new Hono();
  app.post('/webhook/messaging', messagingWebhook);
  return app;
}

// Authenticated variant: mounts sentAuth middleware so signature is validated
// end-to-end (issue #22 AC: "bad signature = 401 + logged").
function createAuthTestApp() {
  const app = new Hono();
  app.post('/webhook/messaging', sentAuth, messagingWebhook);
  return app;
}

describe('POST /webhook/messaging', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('handles new user with welcome message', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('deepseek')) return mockDeepSeekResponse('help', 0.95);
      if ((url as string).includes('sent.dm')) return mockSentResponse('resp_1');
      return new Response('{}', { status: 200 });
    });

    const app = createTestApp();
    const env = createTestEnv();

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_001',
        from: '+6421999888777',
        body: 'hello',
        channel: 'whatsapp',
        timestamp: '2026-05-14T09:30:00+12:00',
      }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('handles new bill submission with media', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('cdn.sent.dm'))
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response;
      if ((url as string).includes('sent.dm')) return mockSentResponse('resp_2');
      return new Response('{}', { status: 200 });
    });

    const existingPhone = '+6421888777666';
    const existingRow = makeUserRow({ id: 'usr-returning', phone: existingPhone });
    const app = createTestApp();
    const env = createTestEnv({ existingPhone, existingUserRow: existingRow });

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_002',
        from: existingPhone,
        body: 'my new bill',
        media: { url: 'https://cdn.sent.dm/test-bill.pdf', type: 'pdf' },
        channel: 'whatsapp',
        timestamp: '2026-05-14T10:00:00+12:00',
      }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 200 even on internal error (prevents Sent retries)', async () => {
    const app = createTestApp();
    const env = createTestEnv();

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {',
    }, env);

    expect(res.status).toBe(200);
  });

  it('handles text message from returning user with intent classification', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('deepseek')) return mockDeepSeekResponse('usage', 0.93);
      if ((url as string).includes('sent.dm')) return mockSentResponse('resp_usage');
      return new Response('{}', { status: 200 });
    });

    const existingPhone = '+6421888777666';
    const existingRow = makeUserRow({ id: 'usr-returning', phone: existingPhone, state: 'ACTIVE' });
    const app = createTestApp();
    const env = createTestEnv({ existingPhone, existingUserRow: existingRow });

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_003',
        from: existingPhone,
        body: 'how much power did I use',
        channel: 'sms',
        timestamp: '2026-05-14T11:00:00+12:00',
      }),
    }, env);

    expect(res.status).toBe(200);
  });

  it('handles empty message body gracefully', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('sent.dm')) return mockSentResponse('resp_empty');
      return new Response('{}', { status: 200 });
    });

    const existingPhone = '+6421888777666';
    const existingRow = makeUserRow({ id: 'usr-returning', phone: existingPhone });
    const app = createTestApp();
    const env = createTestEnv({ existingPhone, existingUserRow: existingRow });

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_004',
        from: existingPhone,
        channel: 'whatsapp',
        timestamp: '2026-05-14T11:30:00+12:00',
      }),
    }, env);

    expect(res.status).toBe(200);
  });

  it('sends OK response within expected latency for WhatsApp ack', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('deepseek')) return mockDeepSeekResponse('help', 0.98);
      if ((url as string).includes('sent.dm')) return mockSentResponse('resp_fast');
      return new Response('{}', { status: 200 });
    });

    const app = createTestApp();
    const env = createTestEnv();

    const start = Date.now();
    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_005',
        from: '+64211234567',
        body: 'help',
        channel: 'whatsapp',
        timestamp: '2026-05-14T12:00:00+12:00',
      }),
    }, env);
    const latency = Date.now() - start;

    expect(res.status).toBe(200);
    expect(latency).toBeLessThan(2000);
  });

  it('uses correct Sent API key from environment', async () => {
    const sentApiKey = 'custom-sent-key-12345';
    let capturedAuthHeader = '';

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((url as string).includes('sent.dm') && init?.headers) {
        capturedAuthHeader = (init.headers as Record<string, string>).Authorization ?? '';
        return mockSentResponse('resp_custom');
      }
      if ((url as string).includes('deepseek')) return mockDeepSeekResponse('help', 0.95);
      return new Response('{}', { status: 200 });
    });

    const app = createTestApp();
    const env = createTestEnv({ envOverrides: { SENT_API_KEY: sentApiKey } });

    await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_006',
        from: '+64211234567',
        body: 'help',
        channel: 'whatsapp',
        timestamp: '2026-05-14T13:00:00+12:00',
      }),
    }, env);

    expect(capturedAuthHeader).toBe(`Bearer ${sentApiKey}`);
  });
});

// Issue #22 — integration tests: full pipeline through sentAuth + handler,
// covering WhatsApp + SMS bodies + bad signature. Mounts sentAuth middleware
// (production path) so signature validation is exercised end-to-end.
describe('POST /webhook/messaging — integration (issue #22)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects request with invalid signature (401)', async () => {
    const app = createAuthTestApp();
    const env = createTestEnv();

    const body = JSON.stringify({
      id: 'msg_int_001',
      from: '+6421999888777',
      body: 'hello',
      channel: 'whatsapp',
      timestamp: '2026-05-14T14:00:00+12:00',
    });
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sent-Signature': 'deadbeef'.repeat(8), // well-formed hex but wrong sig
        'X-Sent-Timestamp': ts,
      },
      body,
    }, env);

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('unauthorized');
  });

  it('rejects request with missing signature header (401)', async () => {
    const app = createAuthTestApp();
    const env = createTestEnv();

    const body = JSON.stringify({
      id: 'msg_int_002',
      from: '+6421999888777',
      body: 'hello',
      channel: 'whatsapp',
      timestamp: '2026-05-14T14:00:00+12:00',
    });

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, env);

    expect(res.status).toBe(401);
  });

  it.each([
    ['whatsapp' as const, 'resp_int_wa'],
    ['sms' as const, 'resp_int_sms'],
  ])('accepts signed %s body and returns 200', async (channel, respId) => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes('deepseek')) return mockDeepSeekResponse('help', 0.95);
      if ((url as string).includes('sent.dm')) return mockSentResponse(respId);
      return new Response('{}', { status: 200 });
    });

    const app = createAuthTestApp();
    const env = createTestEnv();

    const body = JSON.stringify({
      id: `msg_int_${channel}`,
      from: '+6421999888777',
      body: 'help',
      channel,
      timestamp: '2026-05-14T14:30:00+12:00',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await signWebhook(body, ts);

    const res = await app.request('/webhook/messaging', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sent-Signature': signature,
        'X-Sent-Timestamp': ts,
      },
      body,
    }, env);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status: string };
    expect(payload.status).toBe('ok');
  });
});
