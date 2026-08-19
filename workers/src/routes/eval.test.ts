import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  evalUploadPage,
  evalUploadHandler,
  evalResultPage,
  evalStatus,
  runEvalComparison,
  billToSummary,
  computeAvgDailyKwh,
  computeSeasonalWeights,
} from './eval';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Module mocks (vi.mock is hoisted)
// ---------------------------------------------------------------------------

vi.mock('../services/billParser', () => ({
  parseBill: vi.fn(),
}));

vi.mock('../models/bills', () => ({
  createBill: vi.fn(),
  getBillsByUserId: vi.fn(),
  updateBillParsedData: vi.fn(),
}));

vi.mock('../models/users', () => ({
  findOrCreateByPhone: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('../models/comparisons', () => ({
  createComparison: vi.fn(),
}));

vi.mock('../models/plans', () => ({
  getPlansByRegion: vi.fn(),
  getPlansByRetailer: vi.fn(),
}));

vi.mock('../models/retailers', () => ({
  getRetailerNamesByIds: vi.fn(async () => new Map<string, string>()),
}));

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PARSE_RESPONSE = {
  retailer_id: 'contact-energy',
  retailer_name: 'Contact Energy',
  plan_name: 'Good Night Plan',
  meter_type: 'standard',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  days: 30,
  usage_kwh: 800,
  total_cents: 25000,
  c_per_kwh: 25.5,
  c_per_day: 80.0,
  break_fee_cents: 0,
  fixed_term_expiry: null,
  confidence: 0.92,
};

const MOCK_BILL = {
  id: 'bill-123',
  userId: 'user-phone-1',
  retailerId: null,
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
  rawR2Key: 'bills/user-phone-1/12345.pdf',
  parsedJson: null,
  source: 'web',
  createdAt: '2026-05-18T00:00:00Z',
};

const MOCK_PARSED_BILL = {
  id: 'bill-123',
  userId: 'user-phone-1',
  retailerId: 'contact-energy',
  planName: 'Good Night Plan',
  meterType: 'standard' as const,
  periodStart: '2026-04-01',
  periodEnd: '2026-04-30',
  days: 30,
  usageKwh: 800,
  totalCents: 25000,
  cPerKwh: 25.5,
  cPerDay: 80.0,
  fixedTermExpiry: null,
  breakFeeCents: 0,
  status: 'parsed',
  confidence: 0.92,
  rawR2Key: 'bills/user-phone-1/12345.pdf',
  parsedJson: '{}',
  source: 'web' as const,
  createdAt: '2026-05-18T00:00:00Z',
};

const MOCK_PLANS = [
  {
    id: 'plan-1',
    retailerId: 'contact-energy',
    name: 'Good Night Plan',
    region: 'Auckland',
    cPerKwh: 25.5,
    cPerDay: 80.0,
    tierThresholdsJson: null,
    promptPaymentDiscount: null,
    conditionsJson: null,
    lowUserEligible: false,
    source: 'manual' as const,
    eiep14aId: null,
    effectiveFrom: null,
    effectiveTo: null,
  },
  {
    id: 'plan-2',
    retailerId: 'retailer-c',
    name: 'Current (retailer C)',
    region: 'Auckland',
    cPerKwh: 28.0,
    cPerDay: 85.0,
    tierThresholdsJson: null,
    promptPaymentDiscount: null,
    conditionsJson: null,
    lowUserEligible: false,
    source: 'manual' as const,
    eiep14aId: null,
    effectiveFrom: null,
    effectiveTo: null,
  },
];

// Python /compare returns the BARE ranked list (jsonify(results)), NOT an
// object keyed by `comparisons`. Each row carries Python's stamped
// recommendation/reason (the user-level verdict applied identically to every
// row in plan_comparator.py).
const MOCK_COMPARE_RESPONSE = [
  {
    plan_name: 'Good Night Plan',
    retailer_name: 'Contact Energy',
    retailer_id: 'contact-energy',
    projected_cost_cents: 24000,
    current_cost_cents: 25000,
    saving_cents: 1000,
    confidence: 0.85,
    stay_where_you_are: false,
    recommendation: 'switch',
    reason: null,
  },
  {
    plan_name: 'Current (retailer C)',
    retailer_name: 'Retailer C',
    retailer_id: 'retailer-c',
    projected_cost_cents: 25000,
    current_cost_cents: 25000,
    saving_cents: 0,
    confidence: 0.9,
    stay_where_you_are: true,
    recommendation: 'switch',
    reason: null,
  },
];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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
    DB: makeMockDB(),
    KV: makeMockKV(),
    BILLS: { put: vi.fn(async () => {}) },
    ENCRYPTION_KEY: 'test-encryption-key-32bytes!',
    PYTHON_SERVICE_URL: 'http://test-python:8000',
    PYTHON_SERVICE_AUTH_TOKEN: 'test-auth-token',
  };
}

function createTestApp(): Hono {
  const app = new Hono();
  app.get('/eval', evalUploadPage);
  app.post('/eval/upload', evalUploadHandler);
  app.get('/eval/result', evalResultPage);
  app.get('/eval/status', evalStatus);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper to build a FormData representing a PDF file upload. */
function buildUploadForm(
  content: string | Uint8Array | ArrayBuffer,
  fileName: string,
  mimeType: string,
  phone?: string
): FormData {
  const file = new File([content as unknown as BlobPart], fileName, { type: mimeType });
  const fd = new FormData();
  fd.append('file', file);
  if (phone !== undefined) {
    fd.append('phone', phone);
  }
  return fd;
}

const VALID_PDF_CONTENT = '%PDF-1.4 test document content';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /eval', () => {
  it('returns HTML upload form with PDF file input', async () => {
    const app = createTestApp();
    const res = await app.request('/eval', {}, makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Evaluate a power bill');
    expect(html).toContain('<form');
    expect(html).toContain('<input type="file"');
    expect(html).toContain('accept=".pdf');
    expect(html).toContain('action="/eval/upload"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="phone"');
    expect(html).toContain('name="file"');
  });

  it('renders error message when error query param is present', async () => {
    const app = createTestApp();
    const res = await app.request('/eval?error=Something+went+wrong', {}, makeEnv());

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Something went wrong');
    expect(html).toContain('error-msg');
  });
});

// ---------------------------------------------------------------------------
// POST /eval/upload
// ---------------------------------------------------------------------------

describe('POST /eval/upload', () => {
  let env: Record<string, unknown>;
  let kv: KVNamespace;

  beforeEach(async () => {
    env = makeEnv();
    kv = env.KV as KVNamespace;

    // Reset and set up global fetch mock for Python /compare
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMPARE_RESPONSE,
    } as unknown as Response);

    // Configure parseBill mock
    const bp = await import('../services/billParser');
    (bp.parseBill as ReturnType<typeof vi.fn>).mockResolvedValue(
      MOCK_PARSE_RESPONSE
    );

    // Configure findOrCreateByPhone mock
    const users = await import('../models/users');
    (users.findOrCreateByPhone as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: unknown, _enc: unknown, phone: string) => {
        if (phone === 'eval-anonymous') {
          return { user: { id: 'user-anonymous', phone }, created: true };
        }
        return { user: { id: 'user-phone-1', phone }, created: true };
      }
    );

    // Configure bills mocks
    const bills = await import('../models/bills');
    (bills.createBill as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BILL);
    (bills.getBillsByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      MOCK_PARSED_BILL,
    ]);
    (bills.updateBillParsedData as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined
    );

    // Configure plans mocks
    const plans = await import('../models/plans');
    (plans.getPlansByRetailer as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: unknown, retailerId: string) =>
        MOCK_PLANS.filter((p) => p.retailerId === retailerId)
    );
    (plans.getPlansByRegion as ReturnType<typeof vi.fn>).mockResolvedValue(
      MOCK_PLANS
    );

    // Configure createComparison mock
    const comp = await import('../models/comparisons');
    (comp.createComparison as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined
    );
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('processes valid PDF with phone and redirects to result page', async () => {
    const app = createTestApp();
    const formData = buildUploadForm(
      VALID_PDF_CONTENT,
      'bill.pdf',
      'application/pdf',
      '+64211234567'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.1',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).toMatch(/^\/eval\/result\?token=/);

    // Verify data was stored in KV
    const token = location!.split('token=')[1];
    const stored = await kv.get(`eval:${token}`);
    expect(stored).not.toBeNull();

    const parsed = JSON.parse(stored!);
    expect(parsed.parsedData).toBeDefined();
    expect(parsed.parsedData.retailer_id).toBe('contact-energy');
    expect(parsed.comparisons).toHaveLength(2);
    expect(parsed.isAnonymous).toBe(false);

    // #226 — eval writes ONE summary row (not per-plan), matching the live
    // COMPARE_QUEUE shape. The verdict comes from Python's stamped
    // recommendation on every row: MOCK_COMPARE_RESPONSE stamps 'switch', the
    // first row is the switchable one (Good Night Plan), so recommendation ===
    // 'switch' and the recommended plan is plan-1.
    const comp = await import('../models/comparisons');
    expect(comp.createComparison).toHaveBeenCalledTimes(1);
    const persisted = (comp.createComparison as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(persisted).toMatchObject({
      recommendation: 'switch',
      recommendedPlanId: 'plan-1',
      currentPlanId: 'plan-1',
      billId: 'bill-123',
      projectedAnnualCost: 24000,
      savings: 1000,
      currentCostCents: 25000,
      confidence: 0.85,
    });
    // Legacy per-plan input fields are gone from the input shape.
    expect(persisted).not.toHaveProperty('planId');
    expect(persisted).not.toHaveProperty('projectedCostCents');
    expect(persisted).not.toHaveProperty('savingCents');
  });

  // -----------------------------------------------------------------------
  // File validation
  // -----------------------------------------------------------------------

  it('returns error when no file is provided', async () => {
    const app = createTestApp();
    const fd = new FormData();
    fd.append('phone', '');

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.2',
        },
        body: fd,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain(
      encodeURIComponent('Please select a PDF file to upload.')
    );
  });

  it('rejects non-PDF file extensions', async () => {
    const app = createTestApp();
    const formData = buildUploadForm(
      'hello world',
      'notes.txt',
      'text/plain'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.3',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain(
      encodeURIComponent('Only PDF files are accepted.')
    );
  });

  it('rejects oversized files over 10 MB', async () => {
    const app = createTestApp();
    const bigBuffer = new ArrayBuffer(10 * 1024 * 1024 + 1);
    const formData = buildUploadForm(
      bigBuffer,
      'huge.pdf',
      'application/pdf'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.4',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain(
      encodeURIComponent('File is too large. Maximum size is 10 MB.')
    );
  });

  it('rejects files with .pdf extension but missing PDF magic bytes', async () => {
    const app = createTestApp();
    // Valid .pdf extension and application/pdf type, but content is XML not PDF
    const formData = buildUploadForm(
      '<?xml version="1.0"?><fake>not a pdf</fake>',
      'bill.pdf',
      'application/pdf'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.5',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain(
      encodeURIComponent('File does not appear to be a valid PDF.')
    );
  });

  // -----------------------------------------------------------------------
  // Phone handling
  // -----------------------------------------------------------------------

  it('calls findOrCreateByPhone with the provided NZ mobile number', async () => {
    const usersModule = await import('../models/users');
    const findOrCreateByPhone = usersModule
      .findOrCreateByPhone as ReturnType<typeof vi.fn>;
    findOrCreateByPhone.mockClear();

    const app = createTestApp();
    const formData = buildUploadForm(
      VALID_PDF_CONTENT,
      'bill.pdf',
      'application/pdf',
      '+64211234567'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(findOrCreateByPhone).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '+64211234567'
    );
  });

  it('uses eval-anonymous when no phone is provided', async () => {
    const usersModule = await import('../models/users');
    const findOrCreateByPhone = usersModule
      .findOrCreateByPhone as ReturnType<typeof vi.fn>;
    findOrCreateByPhone.mockClear();

    const app = createTestApp();
    const formData = buildUploadForm(
      VALID_PDF_CONTENT,
      'bill.pdf',
      'application/pdf'
      // No phone — field omitted
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.11',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(findOrCreateByPhone).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'eval-anonymous'
    );
  });

  it('uses eval-anonymous when phone is an empty string', async () => {
    const usersModule = await import('../models/users');
    const findOrCreateByPhone = usersModule
      .findOrCreateByPhone as ReturnType<typeof vi.fn>;
    findOrCreateByPhone.mockClear();

    const app = createTestApp();
    const formData = buildUploadForm(
      VALID_PDF_CONTENT,
      'bill.pdf',
      'application/pdf',
      '' // Empty phone string
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.12',
        },
        body: formData,
      },
      env
    );

    expect(res.status).toBe(302);
    expect(findOrCreateByPhone).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'eval-anonymous'
    );
  });

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  it('returns 429 after exceeding rate limit of 5 per minute', async () => {
    // Pre-seed KV with 5 requests from this IP
    await kv.put('rate:eval:203.0.113.100', '5', { expirationTtl: 60 });

    const app = createTestApp();
    const fd = new FormData();
    fd.append('phone', '');

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.100',
        },
        body: fd,
      },
      env
    );

    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toContain('Too many uploads');
  });

  it('allows requests after rate limit resets (new KV key)', async () => {
    // No pre-seeding — this IP has not made any requests
    const app = createTestApp();
    const formData = buildUploadForm(
      VALID_PDF_CONTENT,
      'bill.pdf',
      'application/pdf',
      '+64211234567'
    );

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://flip.example.workers.dev',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.200',
        },
        body: formData,
      },
      env
    );

    // Fresh IP should succeed (rate limit check passes, then full flow)
    expect(res.status).toBe(302);
  });

  // -----------------------------------------------------------------------
  // CSRF
  // -----------------------------------------------------------------------

  it('rejects cross-origin requests with 403', async () => {
    const app = createTestApp();
    const fd = new FormData();
    fd.append('phone', '');

    const res = await app.request(
      '/eval/upload',
      {
        method: 'POST',
        headers: {
          Origin: 'https://evil.com',
          Host: 'flip.example.workers.dev',
          'cf-connecting-ip': '203.0.113.50',
        },
        body: fd,
      },
      env
    );

    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Cross-origin');
  });
});

// ---------------------------------------------------------------------------
// GET /eval/result
// ---------------------------------------------------------------------------

describe('GET /eval/result', () => {
  let env: Record<string, unknown>;
  let kv: KVNamespace;

  beforeEach(() => {
    env = makeEnv();
    kv = env.KV as KVNamespace;
  });

  it('renders parsed bill fields and comparison table for valid token', async () => {
    const parsedData = {
      retailer_name: 'Contact Energy',
      plan_name: 'Good Night Plan',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      days: 30,
      usage_kwh: 800,
      total_cents: 25000,
      c_per_kwh: 25.5,
      c_per_day: 80.0,
      meter_type: 'standard',
      icp_number: 'ICP-123456',
      confidence: 0.92,
    };
    const comparisons = [
      {
        plan_name: 'Good Night Plan',
        retailer_name: 'Contact Energy',
        retailer_id: 'contact-energy',
        projected_cost_cents: 24000,
        current_cost_cents: 25000,
        saving_cents: 1000,
        confidence: 0.85,
        stay_where_you_are: false,
      },
    ];

    await kv.put(
      `eval:valid-token`,
      JSON.stringify({ parsedData, comparisons, isAnonymous: false }),
      { expirationTtl: 86400 }
    );

    const app = createTestApp();
    const res = await app.request('/eval/result?token=valid-token', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const html = await res.text();
    // Parsed bill section
    expect(html).toContain('Contact Energy');
    expect(html).toContain('Good Night Plan');
    expect(html).toContain('800 kWh');
    expect(html).toContain('$250.00');
    expect(html).toContain('ICP-123456');
    expect(html).toContain('92%');
    // Comparison section
    expect(html).toContain('Plan comparison');
    expect(html).toContain('$240.00');
    expect(html).toContain('Could save');
    // Non-anonymous — ICP should NOT be masked
    expect(html).not.toContain('Available (sign in to view)');
    expect(html).toContain('ICP-123456');
  });

  it('shows not-found or expired message for invalid token', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/eval/result?token=nonexistent-token',
      {},
      env
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('not found');
    expect(html).toContain('expired');
  });

  it('shows error message when token is missing', async () => {
    const app = createTestApp();
    const res = await app.request('/eval/result', {}, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing evaluation token');
  });

  it('shows error message when KV data contains error', async () => {
    await kv.put(
      `eval:error-token`,
      JSON.stringify({
        parsedData: null,
        comparisons: null,
        error: 'Parsing failed: Low confidence on parsed data.',
      }),
      { expirationTtl: 86400 }
    );

    const app = createTestApp();
    const res = await app.request('/eval/result?token=error-token', {}, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Parsing failed');
    expect(html).toContain('Low confidence');
  });

  it('shows error from query parameter when no KV error exists', async () => {
    // Pre-store KV data without an error field
    await kv.put(
      `eval:query-error-token`,
      JSON.stringify({
        parsedData: null,
        comparisons: null,
      }),
      { expirationTtl: 86400 }
    );

    const app = createTestApp();
    const res = await app.request(
      '/eval/result?token=query-error-token&error=Something+broke',
      {},
      env
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Something broke');
  });

  it('masks ICP number for anonymous users', async () => {
    await kv.put(
      `eval:anon-token`,
      JSON.stringify({
        parsedData: {
          retailer_name: 'Test Retailer',
          plan_name: 'Test Plan',
          icp_number: 'ICP-SECRET-9876',
        },
        comparisons: null,
        isAnonymous: true,
      }),
      { expirationTtl: 86400 }
    );

    const app = createTestApp();
    const res = await app.request('/eval/result?token=anon-token', {}, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    // The ICP value should be masked
    expect(html).toContain('Available (sign in to view)');
    // The actual ICP number should NOT appear
    expect(html).not.toContain('ICP-SECRET-9876');
  });

  it('shows ICP number directly for non-anonymous users', async () => {
    await kv.put(
      `eval:identified-token`,
      JSON.stringify({
        parsedData: {
          retailer_name: 'Test Retailer',
          plan_name: 'Test Plan',
          icp_number: 'ICP-ABCD-1234',
        },
        comparisons: null,
        isAnonymous: false,
      }),
      { expirationTtl: 86400 }
    );

    const app = createTestApp();
    const res = await app.request(
      '/eval/result?token=identified-token',
      {},
      env
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ICP-ABCD-1234');
    expect(html).not.toContain('Available (sign in to view)');
  });
});

// ---------------------------------------------------------------------------
// GET /eval/status
// ---------------------------------------------------------------------------

describe('GET /eval/status', () => {
  let env: Record<string, unknown>;
  let kv: KVNamespace;

  beforeEach(() => {
    env = makeEnv();
    kv = env.KV as KVNamespace;
  });

  it('returns JSON with parsed data and comparisons for valid token', async () => {
    const storedData = {
      parsedData: { retailer_name: 'Test Retailer' },
      comparisons: [
        { plan_name: 'Plan A', projected_cost_cents: 10000 },
      ],
      isAnonymous: false,
    };
    await kv.put(`eval:status-token`, JSON.stringify(storedData), {
      expirationTtl: 86400,
    });

    const app = createTestApp();
    const res = await app.request('/eval/status?token=status-token', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(true);
    expect(body.parsedData).toEqual(storedData.parsedData);
    expect(body.comparisons).toHaveLength(1);
    expect(body.isAnonymous).toBe(false);
  });

  it('returns 404 with found:false for invalid token', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/eval/status?token=nonexistent',
      {},
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(false);
  });

  it('returns 400 with error when token is missing', async () => {
    const app = createTestApp();
    const res = await app.request('/eval/status', {}, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(false);
    expect(body.error).toContain('Missing token');
  });

  it('returns 500 with error when stored data is corrupt', async () => {
    await kv.put(`eval:corrupt-token`, 'not valid json{{{', {
      expirationTtl: 86400,
    });

    const app = createTestApp();
    const res = await app.request(
      '/eval/status?token=corrupt-token',
      {},
      env
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.found).toBe(false);
    expect(body.error).toContain('Could not read results');
  });
});

// ---------------------------------------------------------------------------
// runEvalComparison — verdict surfacing + retailer UUID → name resolution
//
// The verdict logic ALREADY EXISTED (it drove the plan_comparisons summary-row
// write); these tests pin the contract that it is now plumbed out to the page
// unchanged, plus that retailer UUIDs resolve to human names in one query.
// ---------------------------------------------------------------------------

describe('runEvalComparison (verdict + retailer name resolution)', () => {
  let env: Record<string, unknown>;

  beforeEach(async () => {
    env = makeEnv();

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMPARE_RESPONSE,
    } as unknown as Response);

    const bills = await import('../models/bills');
    (bills.getBillsByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([
      MOCK_PARSED_BILL,
    ]);

    const plans = await import('../models/plans');
    (plans.getPlansByRetailer as ReturnType<typeof vi.fn>).mockResolvedValue(
      MOCK_PLANS.filter((p) => p.retailerId === 'contact-energy')
    );
    (plans.getPlansByRegion as ReturnType<typeof vi.fn>).mockResolvedValue(
      MOCK_PLANS
    );

    const comp = await import('../models/comparisons');
    (comp.createComparison as ReturnType<typeof vi.fn>).mockReset();
    (comp.createComparison as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined
    );

    const retailers = await import('../models/retailers');
    (retailers.getRetailerNamesByIds as ReturnType<typeof vi.fn>).mockReset();
    (
      retailers.getRetailerNamesByIds as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new Map<string, string>());
  });

  it('surfaces a switch verdict taken from Python’s stamped recommendation', async () => {
    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );

    // Python stamps recommendation 'switch' on every MOCK_COMPARE_RESPONSE row;
    // the verdict takes that value. The first row is the switchable one (Good
    // Night Plan, saving 1000), so the verdict names it.
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.recommendation).toBe('switch');
    expect(result.verdict!.planName).toBe('Good Night Plan');
    expect(result.verdict!.currentCostCents).toBe(25000);
    expect(result.verdict!.projectedCostCents).toBe(24000);
    expect(result.verdict!.savingCents).toBe(1000);
    expect(result.verdict!.confidence).toBe(0.85);

    // The summary-row write still happens with the SAME shape — verdict
    // surfacing is additive and must not change the persisted write.
    const comp = await import('../models/comparisons');
    expect(comp.createComparison).toHaveBeenCalledTimes(1);
  });

  it('derives a stay_put verdict when no plan is switchable', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          plan_name: 'Current Plan',
          retailer_name: 'Contact Energy',
          retailer_id: 'contact-energy',
          projected_cost_cents: 25000,
          current_cost_cents: 25000,
          saving_cents: 0,
          confidence: 0.9,
          stay_where_you_are: true,
          recommendation: 'stay_put',
          reason: 'no_savings',
        },
      ],
    } as unknown as Response);

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.recommendation).toBe('stay_put');
    expect(result.verdict!.planName).toBe('Current Plan');
    expect(result.verdict!.savingCents).toBe(0);
  });

  it('returns a null verdict when there is nothing to compare', async () => {
    const bills = await import('../models/bills');
    (bills.getBillsByUserId as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.verdict).toBeNull();
    expect(result.parsedData).toBeNull();
    expect(result.comparisons).toEqual([]);

    // No retailer lookup and no summary-row write on the early-return path.
    const retailers = await import('../models/retailers');
    expect(retailers.getRetailerNamesByIds).not.toHaveBeenCalled();
    const comp = await import('../models/comparisons');
    expect(comp.createComparison).not.toHaveBeenCalled();
  });

  it('resolves the retailer UUID to a name in parsedData and the verdict', async () => {
    const retailers = await import('../models/retailers');
    (
      retailers.getRetailerNamesByIds as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new Map([['contact-energy', 'Contact Energy']]));

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.parsedData!.retailer_name).toBe('Contact Energy');
    expect(result.verdict!.retailerName).toBe('Contact Energy');
  });

  it('fills retailer_name into a comparison item that lacks one, but keeps an existing name', async () => {
    // First row carries NO retailer_name (Python omitted it) → filled in.
    // Second row carries a name that must win even though the map resolves
    // its id to something different.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          plan_name: 'Good Night Plan',
          retailer_id: 'contact-energy',
          projected_cost_cents: 24000,
          current_cost_cents: 25000,
          saving_cents: 1000,
          confidence: 0.85,
          stay_where_you_are: false,
          recommendation: 'switch',
          reason: null,
        },
        {
          plan_name: 'Pre-existing Plan',
          retailer_name: 'Pre-existing Name',
          retailer_id: 'retailer-c',
          projected_cost_cents: 25000,
          current_cost_cents: 25000,
          saving_cents: 0,
          confidence: 0.9,
          stay_where_you_are: true,
          recommendation: 'switch',
          reason: null,
        },
      ],
    } as unknown as Response);

    const retailers = await import('../models/retailers');
    (
      retailers.getRetailerNamesByIds as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      new Map([
        ['contact-energy', 'Contact Energy'],
        ['retailer-c', 'Different From Pre-existing'],
      ])
    );

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.comparisons[0]!.retailer_name).toBe('Contact Energy');
    expect(result.comparisons[1]!.retailer_name).toBe('Pre-existing Name');
  });

  it('issues exactly one batched retailer lookup regardless of comparison count', async () => {
    const retailers = await import('../models/retailers');
    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    // MOCK_COMPARE_RESPONSE has 2 comparison rows + the latest bill's retailer.
    expect(result.comparisons).toHaveLength(2);
    expect(retailers.getRetailerNamesByIds).toHaveBeenCalledTimes(1);
  });

  // --- /compare wire contract (snake_case body + bare-array response) -------
  //
  // runEvalComparison must speak the SAME contract as planComparator.comparePlans:
  // snake_case usage_profile/current_plan/available_plans/bill_history, and the
  // response parsed as a bare ranked list (NOT {comparisons: [...]}).

  it('POSTs a snake_case body matching comparePlans’ wireBody and parses the bare-array response', async () => {
    await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://test-python:8000/compare');
    const body = JSON.parse((init as RequestInit).body as string);

    // Snake_case boundary keys present.
    expect(body.usage_profile).toEqual(
      expect.objectContaining({
        avg_daily_kwh: expect.any(Number),
        meter_type: 'standard',
        seasonal_weight: expect.objectContaining({ summer: expect.any(Number), winter: expect.any(Number) }),
      })
    );
    // 800 kWh / 30 days ≈ 26.67 kWh/day.
    expect(body.usage_profile.avg_daily_kwh).toBeCloseTo(26.67, 1);
    expect(body.current_plan).toEqual(
      expect.objectContaining({ plan_name: 'Good Night Plan', retailer_id: 'contact-energy' })
    );
    expect(Array.isArray(body.available_plans)).toBe(true);
    expect(body.bill_history).toHaveLength(1);
    expect(body.bill_history[0]).toEqual(
      expect.objectContaining({
        id: 'bill-123',
        usage_kwh: 800,
        total_cents: 25000,
        period_start: '2026-04-01',
        period_end: '2026-04-30',
        days: 30,
        break_fee_cents: 0,
      })
    );

    // camelCase keys must be ABSENT (sending them made Python 400).
    expect(body).not.toHaveProperty('usageProfile');
    expect(body).not.toHaveProperty('currentPlan');
    expect(body).not.toHaveProperty('availablePlans');
    expect(body).not.toHaveProperty('billHistory');
    expect(body.bill_history[0]).not.toHaveProperty('usageKwh');
  });

  it('uses Python’s stay_put recommendation even when a positive sub-threshold saving would locally derive switch', async () => {
    // A $3/yr saving is positive but below the $200 switch threshold, so Python
    // stamps recommendation 'stay_put' (reason 'low_savings') even though the
    // row is technically switchable (saving > 0, not stay). The local
    // derivation would say 'switch' — Python's verdict must win.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          plan_name: 'Good Night Plan',
          retailer_name: 'Contact Energy',
          retailer_id: 'contact-energy',
          projected_cost_cents: 24700,
          current_cost_cents: 25000,
          saving_cents: 300, // $3/yr — below the $200 threshold
          confidence: 0.85,
          stay_where_you_are: false,
          recommendation: 'stay_put',
          reason: 'low_savings',
        },
        {
          plan_name: 'Good Night Plan',
          retailer_id: 'contact-energy',
          projected_cost_cents: 25000,
          current_cost_cents: 25000,
          saving_cents: 0,
          confidence: 0.9,
          stay_where_you_are: true,
          recommendation: 'stay_put',
          reason: 'low_savings',
        },
      ],
    } as unknown as Response);

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.recommendation).toBe('stay_put');
  });

  it('passes Python’s reason through to createComparison instead of hardcoded null', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          plan_name: 'Good Night Plan',
          retailer_name: 'Contact Energy',
          retailer_id: 'contact-energy',
          projected_cost_cents: 25000,
          current_cost_cents: 25000,
          saving_cents: 0,
          confidence: 0.9,
          stay_where_you_are: true,
          recommendation: 'stay_put',
          reason: 'no_savings',
        },
      ],
    } as unknown as Response);

    await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );

    const comp = await import('../models/comparisons');
    expect(comp.createComparison).toHaveBeenCalledTimes(1);
    const persisted = (comp.createComparison as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(persisted.recommendation).toBe('stay_put');
    expect(persisted.reason).toBe('no_savings');
  });

  it('falls back to the local recommendation derivation when Python omits the field', async () => {
    // Legacy response shape with no recommendation/reason stamped. The local
    // derivation must still produce a verdict so the page never renders blank.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          plan_name: 'Good Night Plan',
          retailer_name: 'Contact Energy',
          retailer_id: 'contact-energy',
          projected_cost_cents: 24000,
          current_cost_cents: 25000,
          saving_cents: 1000,
          confidence: 0.85,
          stay_where_you_are: false,
        },
        {
          plan_name: 'Good Night Plan',
          retailer_id: 'contact-energy',
          projected_cost_cents: 25000,
          current_cost_cents: 25000,
          saving_cents: 0,
          confidence: 0.9,
          stay_where_you_are: true,
        },
      ],
    } as unknown as Response);

    const result = await runEvalComparison(
      env as unknown as Parameters<typeof runEvalComparison>[0],
      'user-phone-1'
    );
    expect(result.verdict!.recommendation).toBe('switch');
    const comp = await import('../models/comparisons');
    const persisted = (comp.createComparison as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    // No reason from Python → null, never a fabricated value.
    expect(persisted.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Usage-profile helpers — degenerate-but-real bill edge cases.
//
// Drives parser mis-extractions and unusual-but-real bills through
// billToSummary → computeAvgDailyKwh / computeSeasonalWeights and asserts the
// resulting NUMBERS, not just "does not throw". Cases map 1:1 to the task spec.
// ---------------------------------------------------------------------------

describe('usage-profile helpers — degenerate bill edge cases', () => {
  type RawBill = Parameters<typeof billToSummary>[0];
  type Summary = NonNullable<ReturnType<typeof billToSummary>>;

  /** Build a raw bill; defaults are a normal summer bill. Mid-month dates keep
   *  the month stable across every timezone (no rolling at midnight). */
  function raw(over: Partial<RawBill> & Pick<RawBill, 'id'>): RawBill {
    return {
      usageKwh: 300,
      totalCents: 20000,
      periodStart: '2026-01-15',
      periodEnd: '2026-02-14',
      days: 30,
      breakFeeCents: null,
      ...over,
    };
  }

  function summarize(bills: readonly RawBill[]): Summary[] {
    return bills
      .map(billToSummary)
      .filter((b): b is Summary => b !== null);
  }

  // --- billToSummary: which bills enter the profile ------------------------

  describe('billToSummary — exclusion of mis-parses', () => {
    it.each<readonly [string, RawBill]>([
      ['negative day count (case 1)', raw({ id: 'neg-days', days: -5 })],
      ['zero day count (case 2)', raw({ id: 'zero-days', days: 0 })],
      [
        'all-null parse fields (case 9)',
        {
          id: 'all-null',
          usageKwh: null,
          totalCents: null,
          periodStart: null,
          periodEnd: null,
          days: null,
          breakFeeCents: null,
        },
      ],
    ])('rejects a bill with %s', (_label, bill) => {
      expect(billToSummary(bill)).toBeNull();
    });

    it('a rejected bill is excluded, not counted as zero (cases 1 + 9)', () => {
      // One good bill + a negative-days bill + an all-null bill must reduce to
      // just the good bill — the mis-parses neither count as zero usage nor
      // corrupt the denominator.
      const summaries = summarize([
        raw({ id: 'good', usageKwh: 300, days: 30 }),
        raw({ id: 'neg', usageKwh: 600, days: -5 }),
        {
          id: 'null',
          usageKwh: null,
          totalCents: null,
          periodStart: null,
          periodEnd: null,
          days: null,
          breakFeeCents: null,
        },
      ]);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.id).toBe('good');
    });

    it('keeps a zero-usage bill with a real day count (case 3)', () => {
      // A vacant-property bill (0 kWh, real days) is NOT a mis-parse: only
      // non-positive DAYS are rejected. A genuine 0-usage bill stays in.
      expect(
        billToSummary(raw({ id: 'vacant', usageKwh: 0, days: 30 }))
      ).not.toBeNull();
    });

    it('keeps a negative total_cents (credit note) bill (case 4)', () => {
      // total_cents is unrelated to day-count; a refund bill stays in.
      expect(
        billToSummary(raw({ id: 'credit', totalCents: -5000 }))
      ).not.toBeNull();
    });
  });

  // --- computeAvgDailyKwh: exact numbers + the corruption guard -----------

  describe('computeAvgDailyKwh — real numbers', () => {
    it.each<readonly [string, RawBill[], number]>([
      [
        'single bill — onboarding state (case 5)',
        [raw({ id: 'only', usageKwh: 300, days: 30 })],
        10,
      ],
      [
        'negative-days bill excluded — cannot inflate avg (case 1)',
        [
          raw({ id: 'good', usageKwh: 300, days: 30 }),
          raw({ id: 'neg', usageKwh: 600, days: -5 }),
        ],
        10,
      ],
      [
        'zero-days bill excluded (case 2)',
        [
          raw({ id: 'good', usageKwh: 300, days: 30 }),
          raw({ id: 'zero', usageKwh: 300, days: 0 }),
        ],
        10,
      ],
      [
        'zero-usage bill pulls the average down — it is a real bill (case 3)',
        [
          raw({ id: 'vacant', usageKwh: 0, days: 30 }),
          raw({ id: 'normal', usageKwh: 300, days: 30 }),
        ],
        5,
      ],
      [
        'negative total_cents does not affect the avg (case 4)',
        [raw({ id: 'credit', usageKwh: 300, days: 30, totalCents: -5000 })],
        10,
      ],
      [
        'duplicate identical bills do not distort the avg (case 7)',
        [
          raw({ id: 'dup-a', usageKwh: 300, days: 30 }),
          raw({ id: 'dup-b', usageKwh: 300, days: 30 }),
        ],
        10,
      ],
      ['all bills mis-parsed → 0, no divide-by-zero', [raw({ id: 'neg', days: -5 })], 0],
      ['empty profile → 0', [], 0],
    ])('computeAvgDailyKwh: %s → %i kWh/day', (_name, bills, expected) => {
      expect(computeAvgDailyKwh(summarize(bills))).toBe(expected);
    });

    it('rounds to 2 decimals (matches planComparator rounding)', () => {
      // 1000 kWh / 90 days = 11.111… → 11.11
      expect(
        computeAvgDailyKwh(summarize([raw({ id: 'a', usageKwh: 1000, days: 90 })]))
      ).toBe(11.11);
    });
  });

  // --- computeSeasonalWeights ----------------------------------------------

  describe('computeSeasonalWeights — season assignment', () => {
    it('single summer bill (case 5): full usage in summer, none in winter', () => {
      const w = computeSeasonalWeights(
        summarize([
          raw({ id: 'jan', usageKwh: 400, periodStart: '2026-01-15' }),
        ])
      );
      expect(w).toEqual({ summer: 400, winter: 0 });
    });

    it('duplicate identical bills do not distort the seasonal average (case 7)', () => {
      // Two copies of the same summer bill: the per-bill average is unchanged.
      const w = computeSeasonalWeights(
        summarize([
          raw({ id: 'dup-a', usageKwh: 400, periodStart: '2026-01-15' }),
          raw({ id: 'dup-b', usageKwh: 400, periodStart: '2026-01-15' }),
        ])
      );
      expect(w).toEqual({ summer: 400, winter: 0 });
    });

    it('bill spanning a season boundary is assigned wholly to periodStart season (case 8)', () => {
      // Feb 15 → Mar 15: periodStart month (Feb=1) is summer. The autumn half
      // is NOT split out — the whole bill lands in summer. Known imprecision
      // (reported, not fixed: splitting requires a product decision on how to
      // apportion usage across a boundary).
      const w = computeSeasonalWeights(
        summarize([
          raw({
            id: 'boundary',
            usageKwh: 400,
            days: 28,
            periodStart: '2026-02-15',
            periodEnd: '2026-03-15',
          }),
        ])
      );
      expect(w).toEqual({ summer: 400, winter: 0 });
    });

    // Case 6 — a season with NO bills.
    //
    // computeSeasonalWeights returns 0 for a season that has no bills, which the
    // task flagged as "0 reads as 'measured zero'". However the ONLY consumer of
    // this value is the Python /compare body (seasonal_weight), and Python's
    // compare() NEVER reads seasonal_weight — annual cost is projected purely
    // from avg_daily_kwh (the only "seasonal" mention in python/ is a
    // docstring). So this 0 has NO numeric effect on any saving figure today,
    // and a fallback would be inventing a number in guessed units for a consumer
    // that does not exist. Per the task's escape clause the value is left alone
    // and REPORTED. This test pins the current behaviour so any future change to
    // the field is caught loudly.
    it('a season with no bills returns 0 (case 6) — REPORTED, not fixed', () => {
      const w = computeSeasonalWeights(
        summarize([
          raw({ id: 'mar', usageKwh: 300, periodStart: '2026-03-15' }), // March = shoulder
        ])
      );
      expect(w).toEqual({ summer: 0, winter: 0 });
    });

    it('averages per-bill usage within a season (summer + winter mix)', () => {
      const w = computeSeasonalWeights(
        summarize([
          raw({ id: 'jan', usageKwh: 400, periodStart: '2026-01-15' }), // summer (Jan)
          raw({ id: 'dec', usageKwh: 600, periodStart: '2026-12-15' }), // summer (Dec)
          raw({ id: 'jun', usageKwh: 800, periodStart: '2026-06-15' }), // winter (Jun)
        ])
      );
      // summer avg = (400 + 600) / 2 = 500; winter avg = 800 / 1 = 800
      expect(w).toEqual({ summer: 500, winter: 800 });
    });
  });
});
