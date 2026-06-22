import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  evalUploadPage,
  evalUploadHandler,
  evalResultPage,
  evalStatus,
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

const MOCK_COMPARE_RESPONSE = {
  comparisons: [
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
      plan_name: 'Current (retailer C)',
      retailer_name: 'Retailer C',
      retailer_id: 'retailer-c',
      projected_cost_cents: 25000,
      current_cost_cents: 25000,
      saving_cents: 0,
      confidence: 0.9,
      stay_where_you_are: true,
    },
  ],
};

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
  const file = new File([content as BlobPart], fileName, { type: mimeType });
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
