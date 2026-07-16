import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleParseJob, parseBill } from './billParser';

// Mock dependencies
vi.mock('../models/bills', () => ({
  getBillById: vi.fn(),
  updateBillStatus: vi.fn(),
  updateBillParsedData: vi.fn(),
  markBillCompareEnqueued: vi.fn().mockResolvedValue(true),
}));

vi.mock('./messaging', () => ({
  sendText: vi.fn(),
  sendAndLog: vi.fn().mockResolvedValue({ messageId: 'msg-1', channel: 'whatsapp', fallback: false, whatsappAttempts: 1 }),
}));

vi.mock('../models/users', () => ({
  getUserById: vi.fn(),
  updateUser: vi.fn(),
}));

import { getBillById, updateBillStatus, updateBillParsedData, markBillCompareEnqueued } from '../models/bills';
import { getUserById, updateUser } from '../models/users';
import { sendAndLog } from './messaging';

function createMockR2Object(size: number, body: Uint8Array): R2Object {
  return {
    key: 'bills/user123/test.pdf',
    version: '1',
    size,
    etag: 'abc123',
    httpEtag: '"abc123"',
    uploaded: new Date(),
    httpMetadata: {},
    customMetadata: {},
    range: undefined as unknown as R2Range,
    writeHttpMetadata() {},
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => body.buffer,
    text: async () => new TextDecoder().decode(body),
    json: async () => JSON.parse(new TextDecoder().decode(body)),
    blob: async () => new Blob([body as unknown as BlobPart]),
  } as unknown as R2Object;
}

function createMockR2Bucket(objects: Map<string, R2Object>): R2Bucket {
  return {
    get: async (key: string) => objects.get(key) ?? null,
    put: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function createMockQueue(): Queue<{ user_id: string; bill_id: string; parsed_at: string }> {
  return {
    send: vi.fn(),
    sendBatch: vi.fn(),
  } as unknown as Queue<{ user_id: string; bill_id: string; parsed_at: string }>;
}

describe('parseBill', () => {
  it('should POST to Python /parse endpoint and return response', async () => {
    const mockResponse = {
      retailer_id: 'contact',
      plan_name: 'Standard User',
      usage_kwh: 500,
      total_cents: 12500,
      confidence: 0.92,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await parseBill(new Uint8Array([0, 1, 2]).buffer, 'user-1', 'contact', 'http://localhost:8000');

    expect(result.confidence).toBe(0.92);
    expect(result.usage_kwh).toBe(500);
    // AC: forwards user_id + retailer hint in the payload
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body as string);
    expect(body.user_id).toBe('user-1');
    expect(body.retailer_id).toBe('contact');
  });

  it('should classify 5xx as transient (retryable) ParseError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });

    await expect(parseBill(new Uint8Array([0]).buffer, 'user-1', 'contact', 'http://localhost:8000'))
      .rejects.toMatchObject({ errorCode: 'python_502', transient: true });
  });

  it('should classify 4xx as terminal (non-retryable) ParseError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 422 });

    await expect(parseBill(new Uint8Array([0]).buffer, 'user-1', 'contact', 'http://localhost:8000'))
      .rejects.toMatchObject({ errorCode: 'python_422', transient: false });
  });

  it('should classify network/abort errors as transient', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(parseBill(new Uint8Array([0]).buffer, 'user-1', 'contact', 'http://localhost:8000'))
      .rejects.toMatchObject({ errorCode: 'parse_timeout', transient: true });
  });

  it('should throw terminal extract_failed when parser returns an error field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ confidence: 0, error: 'unable to extract text' }),
    });

    await expect(parseBill(new Uint8Array([0]).buffer, 'user-1', 'contact', 'http://localhost:8000'))
      .rejects.toMatchObject({ errorCode: 'extract_failed', transient: false });
  });
});

describe('handleParseJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: idempotency claim wins (first enqueue proceeds).
    vi.mocked(markBillCompareEnqueued).mockResolvedValue(true);
    // Default user: phone set, no installation address on file.
    vi.mocked(getUserById).mockResolvedValue({
      id: 'user123',
      phone: '+64211234567',
      installationAddress: null,
    } as never);
    vi.mocked(updateUser).mockResolvedValue({} as never);
  });

  it('should complete full parse flow with high confidence', async () => {
    const mockBill = {
      id: 'bill123',
      userId: 'user123',
      retailerId: 'contact',
      status: 'pending_parse',
    };

    const mockParsedResult = {
      usage_kwh: 500,
      total_cents: 12500,
      c_per_kwh: 25.0,
      c_per_day: 90.0,
      period_start: '2026-04-01T00:00:00+12:00',
      period_end: '2026-04-30T00:00:00+12:00',
      days: 30,
      plan_name: 'Standard User',
      confidence: 0.92,
    };

    const r2Body = new Uint8Array([1, 2, 3]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/test.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockCompareQueue = createMockQueue();

    // Mock D1 phone query
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ phone: '+64211234567' }),
        }),
      }),
    } as unknown as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);
    vi.mocked(updateBillParsedData).mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockParsedResult,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: mockCompareQueue,
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    await handleParseJob('bill123', 'bills/test.pdf', env);

    expect(updateBillStatus).toHaveBeenCalledWith(mockDb, 'bill123', 'parsing');
    // AC: writes parsed data + status=parsed (parsed_at is set inside the model)
    expect(updateBillParsedData).toHaveBeenCalledWith(
      mockDb,
      'bill123',
      expect.objectContaining({
        status: 'parsed',
        confidence: 0.92,
      })
    );
    expect(markBillCompareEnqueued).toHaveBeenCalledWith(mockDb, 'bill123');
    // AC #43: message shape is snake_case { user_id, bill_id, parsed_at }.
    expect(mockCompareQueue.send).toHaveBeenCalledWith({
      user_id: 'user123',
      bill_id: 'bill123',
      parsed_at: expect.any(String),
    });
    expect(sendAndLog).toHaveBeenCalled();
    // bill_received template body should be rendered with retailer, usage_kwh, days, total_dollars
    expect(sendAndLog).toHaveBeenCalledWith(
      'test-key',
      mockDb,
      { ENCRYPTION_KEY: 'test-encryption-key' },
      'user123',
      '+64211234567',
      expect.stringMatching(/contact/)
    );
  });

  describe('installation address persistence (Gmail-flow fix)', () => {
    const ADDRESS = '1 Queen Street, Auckland Central, Auckland 1010';

    function makeEnv(r2Key: string, body: Uint8Array) {
      const r2Objects = new Map<string, R2Object>();
      r2Objects.set(r2Key, createMockR2Object(body.length, body));
      return {
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }),
          }),
        } as unknown as D1Database,
        BILLS: createMockR2Bucket(r2Objects),
        COMPARE_QUEUE: createMockQueue(),
        SENT_API_KEY: 'test-key',
        ENCRYPTION_KEY: 'test-encryption-key',
        PYTHON_SERVICE_URL: 'http://localhost:8000',
      };
    }

    beforeEach(() => {
      vi.mocked(getBillById).mockResolvedValue({
        id: 'bill-addr',
        userId: 'user123',
        retailerId: 'mercury',
        status: 'pending_parse',
      } as never);
      vi.mocked(updateBillStatus).mockResolvedValue(undefined);
      vi.mocked(updateBillParsedData).mockResolvedValue(undefined);
    });

    it('persists the extracted address (encrypted via updateUser) when the user has none', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ usage_kwh: 500, total_cents: 12500, confidence: 0.92, address: ADDRESS }),
      });
      const env = makeEnv('bills/a.pdf', new Uint8Array([1]));

      await handleParseJob('bill-addr', 'bills/a.pdf', env);

      expect(updateUser).toHaveBeenCalledWith(
        env.DB,
        { ENCRYPTION_KEY: 'test-encryption-key' },
        'user123',
        { installationAddress: ADDRESS }
      );
    });

    it('never overwrites an existing installation address', async () => {
      vi.mocked(getUserById).mockResolvedValue({
        id: 'user123',
        phone: '+64211234567',
        installationAddress: '99 Existing Way, Wellington 6011',
      } as never);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ usage_kwh: 500, total_cents: 12500, confidence: 0.92, address: ADDRESS }),
      });
      const env = makeEnv('bills/b.pdf', new Uint8Array([2]));

      await handleParseJob('bill-addr', 'bills/b.pdf', env);

      expect(updateUser).not.toHaveBeenCalled();
    });

    it('does not call updateUser when the parser returned no address', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ usage_kwh: 500, total_cents: 12500, confidence: 0.92, address: null }),
      });
      const env = makeEnv('bills/c.pdf', new Uint8Array([3]));

      await handleParseJob('bill-addr', 'bills/c.pdf', env);

      expect(updateUser).not.toHaveBeenCalled();
    });

    it('is best-effort: an updateUser failure must not fail the parse job', async () => {
      vi.mocked(updateUser).mockRejectedValue(new Error('D1 write failed'));
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ usage_kwh: 500, total_cents: 12500, confidence: 0.92, address: ADDRESS }),
      });
      const env = makeEnv('bills/d.pdf', new Uint8Array([4]));

      await expect(handleParseJob('bill-addr', 'bills/d.pdf', env)).resolves.toBeUndefined();

      // Parse still completed: parsed data written, compare enqueued.
      expect(updateBillParsedData).toHaveBeenCalledWith(
        env.DB, 'bill-addr', expect.objectContaining({ status: 'parsed' })
      );
      expect(env.COMPARE_QUEUE.send).toHaveBeenCalledTimes(1);
    });

    it('keeps the address (PII) out of the plaintext parsed_json column', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ usage_kwh: 500, total_cents: 12500, confidence: 0.92, address: ADDRESS }),
      });
      const env = makeEnv('bills/e.pdf', new Uint8Array([5]));

      await handleParseJob('bill-addr', 'bills/e.pdf', env);

      const parsedJson = vi.mocked(updateBillParsedData).mock.calls[0]![2].parsedJson as string;
      expect(parsedJson).not.toContain('Queen Street');
      expect(JSON.parse(parsedJson)).not.toHaveProperty('address');
    });
  });

  it('should NOT enqueue comparison when compare was already claimed (idempotent on bill_id)', async () => {
    // Issue #43: a duplicate PARSE_QUEUE redelivery re-runs handleParseJob.
    // markBillCompareEnqueued returns false the second time (the conditional
    // UPDATE found compare_enqueued_at already set), so no second enqueue.
    const mockBill = {
      id: 'bill-idem',
      userId: 'user-idem',
      retailerId: 'contact',
      status: 'pending_parse',
    };

    const mockParsedResult = {
      usage_kwh: 500,
      total_cents: 12500,
      confidence: 0.92,
    };

    const r2Body = new Uint8Array([20, 21]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/idem.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockCompareQueue = createMockQueue();

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ phone: '+64210000001' }),
        }),
      }),
    } as unknown as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);
    vi.mocked(updateBillParsedData).mockResolvedValue(undefined);
    // Idempotency guard: a previous run already claimed the enqueue.
    vi.mocked(markBillCompareEnqueued).mockResolvedValue(false);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockParsedResult,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: mockCompareQueue,
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    await handleParseJob('bill-idem', 'bills/idem.pdf', env);

    // The claim was still attempted (idempotency check ran)...
    expect(markBillCompareEnqueued).toHaveBeenCalledWith(mockDb, 'bill-idem');
    // ...but no COMPARE_QUEUE message was sent for this bill.
    expect(mockCompareQueue.send).not.toHaveBeenCalled();
  });

  it('should set needs_review when confidence is below threshold', async () => {
    const mockBill = {
      id: 'bill456',
      userId: 'user456',
      retailerId: 'mercury',
      status: 'pending_parse',
    };

    const mockParsedResult = {
      usage_kwh: 300,
      total_cents: 7500,
      confidence: 0.45,
    };

    const r2Body = new Uint8Array([4, 5, 6]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/test2.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockCompareQueue = createMockQueue();

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ phone: '+64219876543' }),
        }),
      }),
    } as unknown as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);
    vi.mocked(updateBillParsedData).mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockParsedResult,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: mockCompareQueue,
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    await handleParseJob('bill456', 'bills/test2.pdf', env);

    expect(updateBillParsedData).toHaveBeenCalledWith(
      mockDb,
      'bill456',
      expect.objectContaining({
        status: 'needs_review',
      })
    );
    // Should NOT enqueue comparison for low confidence
    expect(mockCompareQueue.send).not.toHaveBeenCalled();
  });

  it('should read the confidence threshold from env (override default)', async () => {
    // Default is 0.85; env says 0.5, so confidence 0.6 is >= threshold → parsed.
    const mockBill = {
      id: 'bill-env',
      userId: 'user-env',
      retailerId: 'contact',
      status: 'pending_parse',
    };

    const mockParsedResult = {
      usage_kwh: 400,
      total_cents: 10000,
      confidence: 0.6,
    };

    const r2Body = new Uint8Array([10, 11]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/env.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockCompareQueue = createMockQueue();

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ phone: '+64210000000' }),
        }),
      }),
    } as unknown as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);
    vi.mocked(updateBillParsedData).mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockParsedResult,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: mockCompareQueue,
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
      F1_HINT_CONFIDENCE_THRESHOLD: '0.5',
    };

    await handleParseJob('bill-env', 'bills/env.pdf', env);

    // 0.6 >= 0.5 (env override) → parsed
    expect(updateBillParsedData).toHaveBeenCalledWith(
      mockDb,
      'bill-env',
      expect.objectContaining({ status: 'parsed', confidence: 0.6 })
    );
    expect(mockCompareQueue.send).toHaveBeenCalledTimes(1);
  });

  it('should fall back to default 0.85 when threshold env is unset', async () => {
    // No F1_HINT_CONFIDENCE_THRESHOLD: default 0.85 applies, so 0.7 < 0.85 → needs_review.
    const mockBill = {
      id: 'bill-default',
      userId: 'user-default',
      retailerId: 'contact',
      status: 'pending_parse',
    };

    const mockParsedResult = {
      usage_kwh: 400,
      total_cents: 10000,
      confidence: 0.7,
    };

    const r2Body = new Uint8Array([12, 13]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/default.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockCompareQueue = createMockQueue();

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ phone: '+64211111111' }),
        }),
      }),
    } as unknown as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);
    vi.mocked(updateBillParsedData).mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockParsedResult,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: mockCompareQueue,
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    await handleParseJob('bill-default', 'bills/default.pdf', env);

    // 0.7 < 0.85 (default) → needs_review
    expect(updateBillParsedData).toHaveBeenCalledWith(
      mockDb,
      'bill-default',
      expect.objectContaining({ status: 'needs_review', confidence: 0.7 })
    );
    expect(mockCompareQueue.send).not.toHaveBeenCalled();
  });

  it('should handle missing bill gracefully', async () => {
    vi.mocked(getBillById).mockResolvedValue(null as never);

    const env = {
      DB: {} as D1Database,
      BILLS: {} as R2Bucket,
      COMPARE_QUEUE: createMockQueue(),
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
    };

    await handleParseJob('nonexistent', 'bills/nope.pdf', env);

    // Should not throw, should not call updateBillStatus
    expect(updateBillStatus).not.toHaveBeenCalled();
  });

  it('should throw transient ParseError on Python 5xx (retryable by queue)', async () => {
    const mockBill = {
      id: 'bill789',
      userId: 'user789',
      retailerId: 'genesis',
      status: 'pending_parse',
    };

    const r2Body = new Uint8Array([7, 8, 9]);
    const r2Objects = new Map<string, R2Object>();
    r2Objects.set('bills/test3.pdf', createMockR2Object(r2Body.length, r2Body));

    const mockDb = {} as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: createMockQueue(),
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    // The queue consumer catches this, inspects .transient, and retries.
    await expect(handleParseJob('bill789', 'bills/test3.pdf', env))
      .rejects.toMatchObject({ errorCode: 'python_502', transient: true });
  });

  it('should throw terminal ParseError (no_media) when R2 object is missing', async () => {
    const mockBill = {
      id: 'bill000',
      userId: 'user000',
      retailerId: 'contact',
      status: 'pending_parse',
    };

    // Empty R2 bucket — object not found
    const r2Objects = new Map<string, R2Object>();
    const mockDb = {} as D1Database;

    vi.mocked(getBillById).mockResolvedValue(mockBill as never);
    vi.mocked(updateBillStatus).mockResolvedValue(undefined);

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: createMockQueue(),
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    // Terminal: the queue consumer will mark the bill failed + ack immediately.
    await expect(handleParseJob('bill000', 'bills/missing.pdf', env))
      .rejects.toMatchObject({ errorCode: 'no_media', transient: false });
  });
});
