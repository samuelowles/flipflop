import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleParseJob, parseBill } from './billParser';

// Mock dependencies
vi.mock('../models/bills', () => ({
  getBillById: vi.fn(),
  updateBillStatus: vi.fn(),
  updateBillParsedData: vi.fn(),
}));

vi.mock('./messaging', () => ({
  sendMessage: vi.fn(),
}));

import { getBillById, updateBillStatus, updateBillParsedData } from '../models/bills';
import { sendMessage } from './messaging';

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

function createMockQueue(): Queue<{ userId: string; billId: string }> {
  return {
    send: vi.fn(),
    sendBatch: vi.fn(),
  } as unknown as Queue<{ userId: string; billId: string }>;
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

    const result = await parseBill(new Uint8Array([0, 1, 2]).buffer, 'contact', 'http://localhost:8000');

    expect(result.confidence).toBe(0.92);
    expect(result.usage_kwh).toBe(500);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8000/parse',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(parseBill(new Uint8Array([0, 1, 2]).buffer, 'contact', 'http://localhost:8000'))
      .rejects.toThrow('Python parse service returned 500');
  });
});

describe('handleParseJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(updateBillParsedData).toHaveBeenCalledWith(
      mockDb,
      'bill123',
      expect.objectContaining({
        status: 'parsed',
        confidence: 0.92,
      })
    );
    expect(mockCompareQueue.send).toHaveBeenCalledWith({
      userId: 'user123',
      billId: 'bill123',
    });
    expect(sendMessage).toHaveBeenCalled();
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

  it('should handle Python service error', async () => {
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

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    });

    const env = {
      DB: mockDb,
      BILLS: createMockR2Bucket(r2Objects),
      COMPARE_QUEUE: createMockQueue(),
      SENT_API_KEY: 'test-key',
      ENCRYPTION_KEY: 'test-encryption-key',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
    };

    // This should throw since the error occurs after status is set to parsing
    // In the real queue consumer, errors are caught and messages are acked
    await expect(handleParseJob('bill789', 'bills/test3.pdf', env))
      .rejects.toThrow();
  });
});
