import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollAllUsers, pollSingleUser } from './emailPoller';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock encryption — transparent pass-through for testing
vi.mock('../models/encryption', () => ({
  decrypt: vi.fn(async (ciphertext: string) => `decrypted:${ciphertext}`),
  encrypt: vi.fn(async (plaintext: string) => `encrypted:${plaintext}`),
}));

// Mock Gmail auth service
vi.mock('./gmailAuth', () => ({
  refreshAccessToken: vi.fn(),
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  downloadAttachment: vi.fn(),
}));

// Mock retailers model — mock getAllRetailerNames but keep real nameToSearchKeywords
vi.mock('../models/retailers', async () => {
  const actual = await vi.importActual<typeof import('../models/retailers')>(
    '../models/retailers'
  );
  return {
    ...actual,
    getAllRetailerNames: vi.fn(),
  };
});

// Mock bills model
vi.mock('../models/bills', () => ({
  createBill: vi.fn(),
}));

// Mock oauth model
vi.mock('../models/oauth', () => ({
  storeOAuthTokens: vi.fn(),
}));

import { decrypt, encrypt as _encrypt } from '../models/encryption';
import {
  refreshAccessToken,
  searchMessages,
  getMessage,
  downloadAttachment,
} from './gmailAuth';
import { getAllRetailerNames, nameToSearchKeywords } from '../models/retailers';
import { createBill } from '../models/bills';
import { storeOAuthTokens } from '../models/oauth';

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

function makeMockDB(options: {
  oauthRows?: Array<Record<string, unknown>>;
  retailerId?: string | null;
} = {}): D1Database {
  const oauthRows = options.oauthRows ?? [];
  const retailerId = options.retailerId ?? null;

  return {
    prepare: (sql: string) => {
      const boundArgs: unknown[] = [];

      const stmt = {
        bind: (...args: unknown[]) => {
          boundArgs.length = 0;
          boundArgs.push(...args);
          return stmt;
        },
        first: <T>(): Promise<T | null> => {
          // getRetailerById (not used by matchRetailerByName, but kept for safety)
          if (sql.includes('SELECT id FROM retailers')) {
            return Promise.resolve(
              (retailerId ? { id: retailerId } : null) as T | null
            );
          }
          // getGmailTokenForUser reads from oauth_tokens with first()
          if (
            sql.includes('oauth_tokens') &&
            sql.includes('WHERE user_id')
          ) {
            return Promise.resolve(
              (oauthRows.length > 0 ? oauthRows[0] : null) as T | null
            );
          }
          return Promise.resolve(null);
        },
        all: <T>() =>
          Promise.resolve({
            results: (sql.includes('oauth_tokens') ? oauthRows : []) as T[],
          }),
        run: () => Promise.resolve({ meta: {} }),
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeMockR2(): R2Bucket {
  const stored = new Map<string, ArrayBuffer>();
  return {
    put: (key: string, value: ArrayBuffer) => {
      stored.set(key, value);
      return Promise.resolve({} as R2Object);
    },
    get: () => Promise.resolve(null),
    head: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    createMultipartUpload: () => Promise.reject(new Error('not implemented')),
    resumeMultipartUpload: () =>
      Promise.reject(new Error('not implemented')),
  } as unknown as R2Bucket;
}

function makeMockQueue(): Queue<{ billId: string; r2Key: string }> {
  const sent: Array<{ billId: string; r2Key: string }> = [];
  return {
    send: (msg: { billId: string; r2Key: string }) => {
      sent.push(msg);
      return Promise.resolve();
    },
    sendBatch: (msgs: Array<{ billId: string; r2Key: string }>) => {
      sent.push(...msgs);
      return Promise.resolve();
    },
  } as unknown as Queue<{ billId: string; r2Key: string }>;
}

function makeEnv(
  overrides: Partial<{
    oauthRows: Array<Record<string, unknown>>;
    retailerId: string | null;
  }> = {}
): {
  DB: D1Database;
  KV: KVNamespace;
  BILLS: R2Bucket;
  PARSE_QUEUE: Queue<{ billId: string; r2Key: string }>;
  ENCRYPTION_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
} {
  return {
    DB: makeMockDB({
      oauthRows: overrides.oauthRows,
      retailerId: overrides.retailerId,
    }),
    KV: makeMockKV(),
    BILLS: makeMockR2(),
    PARSE_QUEUE: makeMockQueue(),
    ENCRYPTION_KEY: 'test-encryption-key-32bytes!!',
    GMAIL_CLIENT_ID: 'test-client-id',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
  };
}

// ---------- nameToSearchKeywords (pure function) ----------

describe('nameToSearchKeywords', () => {
  // nameToSearchKeywords is the real implementation via vi.importActual

  it('returns quoted phrase for multi-word names', () => {
    expect(nameToSearchKeywords('Contact Energy')).toEqual([
      '"Contact Energy"',
    ]);
  });

  it('returns single-word name with 4+ chars as-is', () => {
    expect(nameToSearchKeywords('Mercury')).toEqual(['Mercury']);
  });

  it('returns single-word name under 4 chars as-is', () => {
    expect(nameToSearchKeywords('Flick')).toEqual(['Flick']);
  });

  it('handles three-word names', () => {
    expect(nameToSearchKeywords('Genesis Energy NZ')).toEqual([
      '"Genesis Energy NZ"',
    ]);
  });
});

// ---------- pollAllUsers ----------

describe('pollAllUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns empty array when no users have Gmail tokens', async () => {
    const env = makeEnv({ oauthRows: [] });

    const results = await pollAllUsers(env);
    expect(results).toEqual([]);
  });

  it('returns empty array when no retailer names are configured', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-tok',
          refresh_token_encrypted: 'enc-ref',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([]);

    const results = await pollAllUsers(env);
    expect(results).toEqual([]);
  });

  it('decrypts tokens and proceeds for a user with valid tokens', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const results = await pollAllUsers(env);

    expect(decrypt).toHaveBeenCalledWith(
      'enc-access',
      'test-encryption-key-32bytes!!'
    );
    expect(decrypt).toHaveBeenCalledWith(
      'enc-refresh',
      'test-encryption-key-32bytes!!'
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.userId).toBe('user-1');
    expect(results[0]!.billsFound).toBe(0);
  });

  it('refreshes expired tokens', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'new-access-token',
      expiry: new Date(Date.now() + 3600000).toISOString(),
    });
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const results = await pollAllUsers(env);

    expect(refreshAccessToken).toHaveBeenCalledWith({
      refreshToken: 'decrypted:enc-refresh',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });
    // Should pass plaintext tokens to storeOAuthTokens (which encrypts internally)
    expect(storeOAuthTokens).toHaveBeenCalledWith(
      env.DB,
      { ENCRYPTION_KEY: 'test-encryption-key-32bytes!!' },
      expect.objectContaining({
        userId: 'user-1',
        provider: 'gmail',
        accessToken: 'new-access-token',
      })
    );
    expect(results).toHaveLength(1);
  });

  it('returns token error when refresh token is missing for expired token', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: null,
          expiry: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);

    const results = await pollAllUsers(env);
    expect(results).toHaveLength(1);
    expect(results[0]!.billsFound).toBe(0);
    expect(results[0]!.errors).toHaveLength(1);
    expect(results[0]!.errors[0]).toContain('Token expired');
  });

  it('processes matching emails with PDF attachments', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
      retailerId: 'ret-001',
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_001',
      threadId: 'thread_1',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'Contact Energy <bills@contact.co.nz>' },
          { name: 'Subject', value: 'Your monthly bill is ready' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att_001', size: 50000 },
            partId: '1',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue({
      id: 'bill-001',
      userId: 'user-1',
      retailerId: 'ret-001',
      planName: null,
      meterType: null,
      periodStart: null,
      periodEnd: null,
      days: null,
      usageKwh: null,
      totalCents: null,
      cPerKwh: null,
      cPerDay: null,
      fixedTermExpiry: null,
      breakFeeCents: null,
      status: 'pending_parse',
      confidence: null,
      rawR2Key: 'bills/user-1/gmail_msg_001_1.pdf',
      parsedJson: null,
      source: 'gmail',
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
    });

    const results = await pollAllUsers(env);

    expect(results).toHaveLength(1);
    expect(results[0]!.billsFound).toBe(1);
    expect(results[0]!.errors).toHaveLength(0);
  });

  it('skips emails without matching subject', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_001',
      threadId: 'thread_1',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'someone@contact.co.nz' },
          { name: 'Subject', value: 'Hello from Contact!' },
        ],
        mimeType: 'text/plain',
      },
    });

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(0);
    // downloadAttachment should not be called
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('skips emails without PDF attachments', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_001',
      threadId: 'thread_1',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'bills@contact.co.nz' },
          { name: 'Subject', value: 'Your bill' },
        ],
        parts: [
          {
            mimeType: 'text/html',
            filename: '',
            body: { attachmentId: undefined, size: 1000 },
            partId: '1',
          },
        ],
        mimeType: 'multipart/alternative',
      },
    });

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(0);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('builds search query with retailer names not domains', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
      { id: 'r2', name: 'Mercury' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await pollAllUsers(env);

    // Query should use retailer names (not domains)
    const callArgs = vi.mocked(searchMessages).mock.calls[0]![0];
    // Contact Energy is multi-word → quoted phrase only
    expect(callArgs.query).toContain('from:"Contact Energy"');
    // Mercury is single-word → used as-is
    expect(callArgs.query).toContain('from:Mercury');
    expect(callArgs.query).toContain('has:attachment');
    expect(callArgs.query).toContain('after:');
  });

  it('uses 365-day lookback for new users without a last-poll cursor', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const before = Date.now();
    await pollAllUsers(env);
    const after = Date.now();

    // Lookback should be 365 days before "now" (YYYY-MM-DD format)
    const expectedDate = new Date(before - 365 * 86400 * 1000).toISOString().slice(0, 10);
    const expectedDateAfter = new Date(after - 365 * 86400 * 1000).toISOString().slice(0, 10);
    const callArgs = vi.mocked(searchMessages).mock.calls[0]![0];
    expect([expectedDate, expectedDateAfter]).toContain(
      callArgs.query.match(/after:(\d{4}-\d{2}-\d{2})/)![1]
    );
  });

  it('uses last-poll cursor for returning users', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    // Pre-set a last-poll KV entry
    await env.KV.put(
      'gmail:lastPoll:user-1',
      '2026-05-10T08:00:00Z'
    );

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await pollAllUsers(env);

    const callArgs = vi.mocked(searchMessages).mock.calls[0]![0];
    // Should use the last-poll date (not 365 days back)
    expect(callArgs.query).toContain('after:2026-05-10');
  });

  it('tracks per-message errors without failing the whole poll', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_bad' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockRejectedValue(new Error('API rate limit'));

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(0);
    expect(results[0]!.errors).toHaveLength(1);
    expect(results[0]!.errors[0]).toContain('msg_bad');
    expect(results[0]!.errors[0]).toContain('API rate limit');
  });

  it('stores poll cursor in KV after successful poll', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await pollAllUsers(env);

    // KV cursor should be stored with a recent ISO timestamp
    const lastPoll = await env.KV.get('gmail:lastPoll:user-1');
    expect(lastPoll).toBeTruthy();
    expect(lastPoll).toMatch(new RegExp(`^${new Date().getFullYear()}-`));
  });

  it('handles multiple users independently', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-1',
          refresh_token_encrypted: 'enc-r1',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
        {
          user_id: 'user-2',
          access_token_encrypted: 'enc-2',
          refresh_token_encrypted: null,
          expiry: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const results = await pollAllUsers(env);

    expect(results).toHaveLength(2);
    // user-1 succeeds
    expect(results[0]!.userId).toBe('user-1');
    expect(results[0]!.errors).toHaveLength(0);
    // user-2 has expired token with no refresh
    expect(results[1]!.userId).toBe('user-2');
    expect(results[1]!.errors).toHaveLength(1);
    expect(results[1]!.errors[0]).toContain('Token expired');
  });

  it('logs poll summary at end', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const logSpy = vi.spyOn(console, 'log');
    await pollAllUsers(env);

    const summaryLog = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l !== null && l.type === 'gmail_poll_summary');

    expect(summaryLog).toBeDefined();
    expect(summaryLog.usersPolled).toBe(1);
    expect(summaryLog.totalBillsFound).toBe(0);
    expect(summaryLog.totalErrors).toBe(0);

    logSpy.mockRestore();
  });

  // ---------- Pagination ----------

  it('paginates through multiple pages of messages', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);

    // First page has nextPageToken, second page does not
    vi.mocked(searchMessages)
      .mockResolvedValueOnce({
        messages: [{ id: 'msg_001' }, { id: 'msg_002' }],
        nextPageToken: 'page_token_2',
        resultSizeEstimate: 4,
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'msg_003' }, { id: 'msg_004' }],
        resultSizeEstimate: 4,
      });

    // Messages don't match bill subject to keep test focused on pagination
    vi.mocked(getMessage).mockResolvedValue({
      id: 'irrelevant',
      threadId: 'thread_x',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'someone@contact.co.nz' },
          { name: 'Subject', value: 'Hello' },
        ],
        mimeType: 'text/plain',
      },
    });

    const results = await pollAllUsers(env);

    // Should have searched twice (two pages)
    expect(searchMessages).toHaveBeenCalledTimes(2);

    // First call: no pageToken
    expect(
      vi.mocked(searchMessages).mock.calls[0]![0].pageToken
    ).toBeUndefined();

    // Second call: has pageToken from first response
    expect(
      vi.mocked(searchMessages).mock.calls[1]![0].pageToken
    ).toBe('page_token_2');

    expect(results[0]!.billsFound).toBe(0);
  });

  it('handles single page with no nextPageToken', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_001',
      threadId: 'thread_x',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'someone@contact.co.nz' },
          { name: 'Subject', value: 'Hello' },
        ],
        mimeType: 'text/plain',
      },
    });

    await pollAllUsers(env);

    // Only one search call (no pagination)
    expect(searchMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------- pollSingleUser ----------

describe('pollSingleUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('writes connecting progress to KV on start', async () => {
    const env = makeEnv({
      oauthRows: [],
    });

    await pollSingleUser(env, 'user-1');

    const progressRaw = await env.KV.get('gmail:scan:user-1');
    expect(progressRaw).not.toBeNull();

    const progress = JSON.parse(progressRaw!);
    expect(progress.phase).toBe('complete');
    expect(progress.complete).toBe(true);
    expect(progress.errors).toContain('No Gmail tokens found for user');
  });

  it('writes full scan progress with phase transitions', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const result = await pollSingleUser(env, 'user-1');

    // Final progress in KV
    const progressRaw = await env.KV.get('gmail:scan:user-1');
    expect(progressRaw).not.toBeNull();

    const progress = JSON.parse(progressRaw!);
    expect(progress.phase).toBe('complete');
    expect(progress.complete).toBe(true);
    expect(progress.messagesFound).toBe(0);
    expect(progress.billsFound).toBe(0);
    expect(Array.isArray(progress.billSenders)).toBe(true);
    expect(Array.isArray(progress.filteredSenders)).toBe(true);
    expect(Array.isArray(progress.errors)).toBe(true);
    expect(progress.startedAt).toBeDefined();
    expect(progress.finishedAt).toBeDefined();
    // initial connecting write, then searching, scanning, complete
    expect(result.userId).toBe('user-1');
  });

  it('writes periodic progress updates every 5 messages', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);

    // 6 messages to trigger at least one periodic write at messagesScanned % 5 === 0
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [
        { id: 'msg_001' },
        { id: 'msg_002' },
        { id: 'msg_003' },
        { id: 'msg_004' },
        { id: 'msg_005' },
        { id: 'msg_006' },
      ],
      resultSizeEstimate: 6,
    });

    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg',
      threadId: 'thread',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'someone@contact.co.nz' },
          { name: 'Subject', value: 'Hello' },
        ],
        mimeType: 'text/plain',
      },
    });

    await pollSingleUser(env, 'user-1');

    const progressRaw = await env.KV.get('gmail:scan:user-1');
    expect(progressRaw).not.toBeNull();

    const progress = JSON.parse(progressRaw!);
    expect(progress.phase).toBe('complete');
    expect(progress.messagesScanned).toBe(6);
    expect(progress.messagesFound).toBe(6);
    expect(progress.complete).toBe(true);
  });

  it('records token error in scan progress', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: null,
          expiry: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy' },
    ]);

    const result = await pollSingleUser(env, 'user-1');

    const progressRaw = await env.KV.get('gmail:scan:user-1');
    expect(progressRaw).not.toBeNull();

    const progress = JSON.parse(progressRaw!);
    expect(progress.phase).toBe('complete');
    expect(progress.complete).toBe(true);
    expect(progress.errors.length).toBeGreaterThan(0);
    expect(progress.errors[0]).toContain('Token expired');

    expect(result.billsFound).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('reports bills found from matching emails in scan progress', async () => {
    const env = makeEnv({
      oauthRows: [
        {
          user_id: 'user-1',
          access_token_encrypted: 'enc-access',
          refresh_token_encrypted: 'enc-refresh',
          expiry: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });

    vi.mocked(getAllRetailerNames).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy' },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });
    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_001',
      threadId: 'thread_1',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'Contact Energy <bills@contact.co.nz>' },
          { name: 'Subject', value: 'Your monthly bill is ready' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att_001', size: 50000 },
            partId: '1',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue({
      id: 'bill-001',
      userId: 'user-1',
      retailerId: 'ret-001',
      planName: null,
      meterType: null,
      periodStart: null,
      periodEnd: null,
      days: null,
      usageKwh: null,
      totalCents: null,
      cPerKwh: null,
      cPerDay: null,
      fixedTermExpiry: null,
      breakFeeCents: null,
      status: 'pending_parse',
      confidence: null,
      rawR2Key: 'bills/user-1/gmail_msg_001_1.pdf',
      parsedJson: null,
      source: 'gmail',
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
    });

    const result = await pollSingleUser(env, 'user-1');

    const progressRaw = await env.KV.get('gmail:scan:user-1');
    const progress = JSON.parse(progressRaw!);

    expect(progress.billsFound).toBe(1);
    expect(progress.billSenders).toContain(
      'Contact Energy <bills@contact.co.nz>'
    );
    expect(result.billsFound).toBe(1);
  });
});
