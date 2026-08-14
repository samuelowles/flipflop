import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollAllUsers, pollSingleUser } from './emailPoller';
import { buildLinkOnlySearchQuery, buildSearchQuery, matchRetailer, processMessage, isForwarded, LINK_ONLY_RETAILER_NAMES } from './emailPipeline';

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

// Mock retailers model — mock getAllRetailersForSearch but keep real nameToSearchKeywords
vi.mock('../models/retailers', async () => {
  const actual = await vi.importActual<typeof import('../models/retailers')>(
    '../models/retailers'
  );
  return {
    ...actual,
    getAllRetailerNames: vi.fn(),
    getAllRetailersForSearch: vi.fn(),
  };
});

// Mock bills model
vi.mock('../models/bills', () => ({
  createBill: vi.fn(),
  getBillBySourceMessageId: vi.fn(),
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
import { getAllRetailersForSearch, nameToSearchKeywords } from '../models/retailers';
import { createBill, getBillBySourceMessageId } from '../models/bills';
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

function makeMockQueue(): Queue<{ billId: string; r2Key: string; userId: string }> {
  const sent: Array<{ billId: string; r2Key: string; userId: string }> = [];
  return {
    send: (msg: { billId: string; r2Key: string; userId: string }) => {
      sent.push(msg);
      return Promise.resolve();
    },
    sendBatch: (msgs: Array<{ billId: string; r2Key: string; userId: string }>) => {
      sent.push(...msgs);
      return Promise.resolve();
    },
  } as unknown as Queue<{ billId: string; r2Key: string; userId: string }> & { sent: typeof sent };
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
  PARSE_QUEUE: Queue<{ billId: string; r2Key: string; userId: string }>;
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([]);

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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
      errorCode: null,
      parsedAt: null,
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
      { id: 'r2', name: 'Mercury', emailDomains: ['mercury.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
      errorCode: null,
      parsedAt: null,
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

// ---------- Issue #227 — Gmail bill discovery overhaul ----------
//
// Seven mandatory test cases from the issue spec. Each maps to a numbered fix:
//   1. dedup via sourceMessageId
//   2. recursive MIME walk (nested multipart/mixed)
//   2. octet-stream + .pdf filename
//   3+4. domain-match + demoted subject → bill found with subjectMatched:false
//   4. unknown-sender + PDF still skipped (subject hard gate intact)
//   3. buildSearchQuery union property (every domain AND every name keyword)
//   6. cursor safety (failed run → not advanced; clean run → advanced)

describe('Issue #227 — Gmail bill discovery overhaul', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Default: no existing bill (dedup returns null).
    vi.mocked(getBillBySourceMessageId).mockResolvedValue(null);
  });

  // Standard bill mock returned by createBill for these tests.
  const billMock = {
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
    status: 'pending_parse' as const,
    confidence: null,
    rawR2Key: 'bills/user-1/gmail_msg_001_0.pdf',
    parsedJson: null,
    source: 'gmail' as const,
    sourceMessageId: 'gmail_msg_001_0',
    errorCode: null,
    parsedAt: null,
    createdAt: new Date().toISOString(),
  };

  function userRow(): Array<Record<string, unknown>> {
    return [
      {
        user_id: 'user-1',
        access_token_encrypted: 'enc-access',
        refresh_token_encrypted: 'enc-refresh',
        expiry: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
  }

  // FIX 1 — dedup: processing the same message twice yields exactly one
  // bills row and the second run logs skipped_duplicate.
  it('skips a duplicate message on re-process (dedup via sourceMessageId)', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
          { name: 'From', value: 'Contact Energy <bills@contactenergy.co.nz>' },
          { name: 'Subject', value: 'Your monthly bill is ready' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att_001', size: 50000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue(billMock);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // First run: no existing bill → createBill called once.
    await pollAllUsers(env);
    expect(createBill).toHaveBeenCalledTimes(1);
    expect(createBill).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ sourceMessageId: 'gmail_msg_001_0' })
    );

    // Second run: dedup returns the existing bill → createBill NOT called again.
    vi.mocked(getBillBySourceMessageId).mockResolvedValue(billMock);
    vi.mocked(createBill).mockClear();
    await pollAllUsers(env);
    expect(createBill).not.toHaveBeenCalled();

    // The skipped_duplicate log line was emitted.
    const skipLog = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l !== null && l.reason === 'skipped_duplicate');
    expect(skipLog).toBeDefined();
    expect(skipLog.billId).toBe('bill-001');

    logSpy.mockRestore();
  });

  // FIX 2 — recursive MIME walk: a PDF nested two levels deep under
  // multipart/mixed → multipart/alternative is found.
  it('finds a PDF nested two levels deep in multipart/mixed', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
          { name: 'From', value: 'Contact Energy <bills@contactenergy.co.nz>' },
          { name: 'Subject', value: 'Your invoice' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            filename: '',
            body: { size: 0 },
            partId: '0',
            parts: [
              {
                mimeType: 'text/plain',
                filename: '',
                body: { size: 1234 },
                partId: '0.0',
              },
              {
                mimeType: 'application/pdf',
                filename: 'invoice.pdf',
                body: { attachmentId: 'att_nested', size: 90000 },
                partId: '0.1',
              },
            ],
          },
        ],
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue(billMock);

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(1);
    expect(downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'att_nested' })
    );
  });

  // FIX 2 — octet-stream + .pdf filename is accepted as a bill PDF.
  it('accepts application/octet-stream with a .pdf filename as a bill PDF', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
          { name: 'From', value: 'Contact Energy <bills@contactenergy.co.nz>' },
          { name: 'Subject', value: 'Your statement' },
        ],
        parts: [
          {
            mimeType: 'application/octet-stream',
            filename: 'invoice.pdf',
            body: { attachmentId: 'att_octet', size: 80000 },
            partId: '1',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue(billMock);

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(1);
    expect(downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'att_octet' })
    );
  });

  // FIX 3 + 4 — domain match + demoted subject: a message whose From domain
  // matches a retailer but whose subject has NO bill keyword is still parsed,
  // and subjectMatched:false is logged.
  it('finds a bill from a matching domain with a non-keyword subject (subjectMatched:false)', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
          { name: 'From', value: 'Contact Energy <bills@contactenergy.co.nz>' },
          // No bill/invoice/statement/account keyword.
          { name: 'Subject', value: 'Your monthly energy summary' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att_001', size: 50000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));
    vi.mocked(createBill).mockResolvedValue(billMock);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const results = await pollAllUsers(env);

    // Bill was found despite the non-keyword subject.
    expect(results[0]!.billsFound).toBe(1);
    expect(createBill).toHaveBeenCalledTimes(1);

    // subjectMatched:false recorded in the processed log line.
    const processedLog = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l !== null && l.type === 'gmail_message_processed');
    expect(processedLog).toBeDefined();
    expect(processedLog.subjectMatched).toBe(false);
    expect(processedLog.retailerMatched).toBe(true);

    logSpy.mockRestore();
  });

  // FIX 4 — unknown-sender protection: an unknown sender with a PDF and a
  // non-keyword subject is still skipped (subject remains a hard gate when
  // retailer match failed).
  it('skips an unknown sender with a PDF and non-keyword subject (hard gate intact)', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'ret-001', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
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
          // Unknown sender — no retailer domain or name.
          { name: 'From', value: 'Spammer <deals@totally-unrelated.example>' },
          { name: 'Subject', value: 'Special offer just for you' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'coupon.pdf',
            body: { attachmentId: 'att_001', size: 5000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const results = await pollAllUsers(env);

    expect(results[0]!.billsFound).toBe(0);
    expect(createBill).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();

    const skipLog = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l !== null && l.reason === 'skipped_no_retailer_match');
    expect(skipLog).toBeDefined();

    logSpy.mockRestore();
  });

  // FIX 3 — buildSearchQuery union property: the query contains every seeded
  // domain AND every existing name keyword (union, not replacement).
  it('buildSearchQuery contains every domain AND every name keyword (union)', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
      { id: 'r2', name: 'Mercury', emailDomains: ['mercury.co.nz'] },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await pollAllUsers(env);

    const query = vi.mocked(searchMessages).mock.calls[0]![0].query;
    // Every domain present.
    expect(query).toContain('from:contactenergy.co.nz');
    expect(query).toContain('from:mercury.co.nz');
    // Every name keyword present (union, not replacement).
    expect(query).toContain('from:"Contact Energy"');
    expect(query).toContain('from:Mercury');
    expect(query).toContain('has:attachment');
  });

  // FIX 6 — cursor safety: a failed run (processMessage error) does NOT
  // advance the cursor; a clean run DOES.
  it('does not advance the poll cursor on a failed run, but does on a clean run', async () => {
    const env = makeEnv({ oauthRows: userRow() });

    vi.mocked(getAllRetailersForSearch).mockResolvedValue([
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
    ]);
    vi.mocked(searchMessages).mockResolvedValue({
      messages: [{ id: 'msg_001' }],
      resultSizeEstimate: 1,
    });

    // === FAILED RUN: getMessage throws → processMessage returns an error. ===
    vi.mocked(getMessage).mockRejectedValueOnce(new Error('Gmail API down'));

    // Pre-seed a cursor so we can detect whether it changed.
    await env.KV.put('gmail:lastPoll:user-1', '2026-01-01T00:00:00Z');
    const cursorBefore = await env.KV.get('gmail:lastPoll:user-1');

    await pollAllUsers(env);

    const cursorAfterFailed = await env.KV.get('gmail:lastPoll:user-1');
    expect(cursorAfterFailed).toBe(cursorBefore); // NOT advanced

    // === CLEAN RUN: getMessage succeeds, no messages error. ===
    vi.mocked(getMessage).mockResolvedValueOnce({
      id: 'msg_001',
      threadId: 'thread_1',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'noreply@example.com' },
          { name: 'Subject', value: 'Hello' },
        ],
        mimeType: 'text/plain',
      },
    });

    await pollAllUsers(env);

    const cursorAfterClean = await env.KV.get('gmail:lastPoll:user-1');
    expect(cursorAfterClean).not.toBe(cursorBefore); // advanced
    expect(cursorAfterClean).toMatch(new RegExp(`^${new Date().getFullYear()}-`));
  });
});

// ---------- Direct-from-retailer ingestion (no forwarded bills) ----------
//
// Ingest ONLY bills sent directly by the retailer — never forwarded copies.
// The From header is the sole retailer signal: buildSearchQuery emits from:
// terms only (no subject: union), and processMessage rejects forwarded mail
// (Fwd:/FW: Subject or X-Forwarded-* header) and any unmatched sender. These
// cover the search-query shape, the forwarded guard, and Mercury's registered
// billing domain (migration 0019).

const MERCURY_ID = '2951d6b6-436e-474b-8ea9-7fb5092cc069';
const MERCURY_ENTRY = {
  id: MERCURY_ID,
  name: 'Mercury',
  emailDomains: ['mercury.co.nz', 'mercuryonline.co.nz'],
};

describe('Direct-from-retailer ingestion (no forwarded bills)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Default: no existing bill (dedup returns null).
    vi.mocked(getBillBySourceMessageId).mockResolvedValue(null);
  });

  // buildSearchQuery emits ONLY from: terms inside the group (every retailer
  // domain AND name keyword), has:attachment outside it, and no subject: term
  // anywhere — forwarded bills are intentionally not discoverable via subject.
  it('buildSearchQuery emits only from: terms inside the group, has:attachment outside (no subject:)', () => {
    const retailers = [
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
      MERCURY_ENTRY,
    ];
    const query = buildSearchQuery(retailers);

    const closeIdx = query.indexOf('}');
    const braceGroup = query.slice(1, closeIdx);
    const afterGroup = query.slice(closeIdx + 1);

    // Every retailer still present as a from: term (domains + name keywords).
    expect(braceGroup).toContain('from:contactenergy.co.nz');
    expect(braceGroup).toContain('from:"Contact Energy"');
    expect(braceGroup).toContain('from:mercury.co.nz');
    expect(braceGroup).toContain('from:Mercury');
    // No subject: terms anywhere — forwarded bills are intentionally not
    // discoverable via the subject.
    expect(query).not.toMatch(/subject:/i);
    // has:attachment lives OUTSIDE the brace group.
    expect(braceGroup).not.toContain('has:attachment');
    expect(afterGroup).toContain('has:attachment');
  });

  // after: stays OUTSIDE the group and is slash-formatted YYYY/MM/DD.
  it('buildSearchQuery places after: outside the group as YYYY/MM/DD', () => {
    const query = buildSearchQuery([MERCURY_ENTRY], '2026-08-15');

    const closeIdx = query.indexOf('}');
    const braceGroup = query.slice(1, closeIdx);
    expect(braceGroup).not.toContain('after:');
    expect(query).toMatch(/} has:attachment after:\d{4}\/\d{2}\/\d{2}$/);
  });

  // matchRetailer matches Mercury's real billing sender domain.
  it('matchRetailer matches Mercury for onlinebills@mercuryonline.co.nz', () => {
    expect(
      matchRetailer([MERCURY_ENTRY], 'Mercury <onlinebills@mercuryonline.co.nz>')
    ).toBe(MERCURY_ID);
  });

  // A retailer-lookalike forward survives the sender match (From is a real
  // retailer domain), so the forwarded guard must reject it on the Subject.
  it('skips a retailer-from message whose subject is "Fwd: …" as skipped_forwarded', async () => {
    const env = makeEnv();

    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_fwd',
      threadId: 'thread_fwd',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'Mercury <onlinebills@mercuryonline.co.nz>' },
          { name: 'Subject', value: 'Fwd: Your Mercury Online Bill' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'mercury-bill.pdf',
            body: { attachmentId: 'att_fwd', size: 50000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));

    const result = await processMessage(
      env,
      'user-1',
      { messageId: 'msg_fwd', accessToken: 'tok' },
      [MERCURY_ENTRY]
    );

    expect(result.billsFound).toBe(0);
    expect(result.skipReason).toBe('skipped_forwarded');
    expect(createBill).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  // Gmail filter-based auto-forwarding sets X-Forwarded-For / X-Forwarded-To.
  // A retailer-lookalike forward carrying one is skipped even without a Fwd:
  // subject prefix.
  it('skips a retailer-from message carrying an X-Forwarded-For header as skipped_forwarded', async () => {
    const env = makeEnv();

    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_xfwd',
      threadId: 'thread_xfwd',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'Mercury <onlinebills@mercuryonline.co.nz>' },
          { name: 'Subject', value: 'Your Mercury Online Bill' },
          { name: 'X-Forwarded-For', value: 'original@gmail.com' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'mercury-bill.pdf',
            body: { attachmentId: 'att_xfwd', size: 50000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));

    const result = await processMessage(
      env,
      'user-1',
      { messageId: 'msg_xfwd', accessToken: 'tok' },
      [MERCURY_ENTRY]
    );

    expect(result.billsFound).toBe(0);
    expect(result.skipReason).toBe('skipped_forwarded');
    expect(createBill).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  // An unknown sender can no longer be rescued by a bill-like subject. This
  // message ("Your Power Bill") was previously ingested because the old compound
  // gate (retailerId === null && !subjectMatched) let subjectMatched through.
  it('skips an unknown sender with a bill-like subject as skipped_no_retailer_match', async () => {
    const env = makeEnv();
    const retailers = [
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
    ];

    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_subjectbill',
      threadId: 'thread_x',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'deals@totally-unrelated.example' },
          { name: 'Subject', value: 'Your Power Bill' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'bill.pdf',
            body: { attachmentId: 'att_subj', size: 5000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));

    const result = await processMessage(
      env,
      'user-1',
      { messageId: 'msg_subjectbill', accessToken: 'tok' },
      retailers
    );

    expect(result.billsFound).toBe(0);
    expect(result.skipReason).toBe('skipped_no_retailer_match');
    // subjectMatched is still reported even though it is no longer a gate.
    expect(result.subjectMatched).toBe(true);
    expect(createBill).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  // Gate intact — unknown From AND unknown Subject (no retailer match) is still
  // skipped, proving the direct-sender rule did not loosen into ingest-everything.
  it('still skips when neither From nor Subject matches a retailer', async () => {
    const env = makeEnv();
    const retailers = [
      { id: 'r1', name: 'Contact Energy', emailDomains: ['contactenergy.co.nz'] },
    ];

    vi.mocked(getMessage).mockResolvedValue({
      id: 'msg_unrelated',
      threadId: 'thread_x',
      internalDate: '1715644800000',
      payload: {
        headers: [
          { name: 'From', value: 'someone@gmail.com' },
          { name: 'Subject', value: 'Special offer just for you' },
        ],
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'coupon.pdf',
            body: { attachmentId: 'att_unrelated', size: 5000 },
            partId: '0',
          },
        ],
        mimeType: 'multipart/mixed',
      },
    });
    vi.mocked(downloadAttachment).mockResolvedValue(new ArrayBuffer(100));

    const result = await processMessage(
      env,
      'user-1',
      { messageId: 'msg_unrelated', accessToken: 'tok' },
      retailers
    );

    expect(result.billsFound).toBe(0);
    expect(result.skipReason).toBe('skipped_no_retailer_match');
    expect(createBill).not.toHaveBeenCalled();
  });
});

// ---------- isForwarded (forwarded-message guard, pure helper) ----------

describe('isForwarded (forwarded-message guard)', () => {
  it('detects a leading Fwd: subject marker', () => {
    expect(isForwarded([], 'Fwd: Your Mercury Online Bill')).toBe(true);
  });

  it('detects repeated markers and leading whitespace', () => {
    expect(isForwarded([], '  Fwd: Fwd: Your bill')).toBe(true);
  });

  it('detects FW: and Fw: case-insensitively', () => {
    expect(isForwarded([], 'FW: your bill')).toBe(true);
    expect(isForwarded([], 'fw: your bill')).toBe(true);
  });

  it('does not match a body word or a non-prefixed subject', () => {
    expect(isForwarded([], 'Your Power Bill')).toBe(false);
    // "Forward:" is not one of the supported markers (Fwd/Fw/FW only).
    expect(isForwarded([], 'Forward: something')).toBe(false);
  });

  it('detects an X-Forwarded-For / X-Forwarded-To header', () => {
    expect(isForwarded([{ name: 'X-Forwarded-For', value: 'x@y.com' }], 'Your bill')).toBe(true);
    expect(isForwarded([{ name: 'X-Forwarded-To', value: 'x@y.com' }], 'Your bill')).toBe(true);
  });

  it('returns false for a direct retailer send (no marker, no forward header)', () => {
    expect(
      isForwarded([{ name: 'From', value: 'mercury@mercury.co.nz' }], 'Your Mercury Online Bill')
    ).toBe(false);
  });
});

describe('link-only retailers (Electric Kiwi, Powershop)', () => {
  const EK_ENTRY = {
    id: 'r-ek',
    name: 'Electric Kiwi',
    emailDomains: ['electrickiwi.co.nz'],
  };
  const MERCURY = { id: 'r-mercury', name: 'Mercury', emailDomains: ['mercury.co.nz'] };

  it('omits has:attachment — the clause that hides these bills from the main scan', () => {
    const query = buildLinkOnlySearchQuery(EK_ENTRY);
    expect(query).not.toBeNull();
    expect(query).not.toContain('has:attachment');
  });

  it('searches the same senders the main query would', () => {
    const query = buildLinkOnlySearchQuery(EK_ENTRY)!;
    expect(query).toContain('from:electrickiwi.co.nz');
    expect(query).toContain('from:"Electric Kiwi"');
    expect(query).toContain('subject:"Electric Kiwi"');
  });

  it('returns null for a PDF-attaching retailer so no extra Gmail call is made', () => {
    // Mercury attaches a PDF; the main scan already finds it. Detecting it here
    // would spend a round-trip to learn nothing.
    expect(buildLinkOnlySearchQuery(MERCURY)).toBeNull();
  });

  it('scopes the query to one retailer so a hit names that retailer', () => {
    const query = buildLinkOnlySearchQuery(EK_ENTRY)!;
    expect(query).not.toContain('Powershop');
  });

  it('keeps after: outside the group, formatted YYYY/MM/DD', () => {
    const query = buildLinkOnlySearchQuery(EK_ENTRY, '2026-08-15')!;
    const braceGroup = query.slice(1, query.indexOf('}'));
    expect(braceGroup).not.toContain('after:');
    expect(query).toMatch(/} after:\d{4}\/\d{2}\/\d{2}$/);
  });

  it('lists exactly the retailers documented as link-only', () => {
    // Guards against a retailer being added here without the coverage matrix
    // (docs/RETAILER_EMAIL_COVERAGE.md) being updated to match.
    expect([...LINK_ONLY_RETAILER_NAMES].sort()).toEqual(['Electric Kiwi', 'Powershop']);
  });
});
