import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index';
import { createUser, updateUser, getUserById } from '../models/users';
import { createBill, getBillById } from '../models/bills';

/**
 * End-to-end: parse -> compare -> notify, through the REAL queue consumers,
 * against a REAL D1 with every migration applied, real KV and real R2.
 *
 * Only the outbound trust boundaries are stubbed (the Python service and the
 * Sent messaging API). Everything between them is production code.
 *
 * The unit suite mocks all of this, which is why the last live run surfaced
 * five integration bugs that 900+ green tests had not caught.
 */

const PYTHON = 'https://python.test';

/** A realistic /parse response — the Mercury bill this project debugs against. */
const PARSE_RESPONSE = {
  // The real contract: Python returns `retailer` (display name). It has no
  // retailer_id field — see ParseServiceResponse in billParser.ts.
  retailer: 'Mercury',
  plan_name: 'Unknown',
  meter_type: 'standard',
  period_start: '2026-06-26',
  period_end: '2026-07-27',
  days: 32,
  usage_kwh: 1113.88,
  total_cents: 39518,
  c_per_kwh: 22.49,
  c_per_day: 291.0,
  fixed_term_expiry: null,
  break_fee_cents: 0,
  confidence: 0.909,
  address: '14 KOWHAI STREET, BIRKDALE, AUCKLAND',
};

/**
 * A /compare response with a clearly switch-worthy saving, built from a REAL
 * seeded plan. plan_comparisons.plan_id is a FK to plans(id), and the
 * comparator refuses to persist a recommendation it cannot match to a seeded
 * plan ("recommended plan not matchable") — so a made-up id silently exercises
 * the guard instead of the write path.
 */
let COMPARE_RESPONSE: unknown[] = [];

async function buildCompareResponse(): Promise<void> {
  const plan = await env.DB.prepare(
    'SELECT p.id, p.name, p.retailer_id, r.name AS retailer_name ' +
    'FROM plans p JOIN retailers r ON r.id = p.retailer_id LIMIT 1'
  ).first<{ id: string; name: string; retailer_id: string; retailer_name: string }>();
  if (!plan) throw new Error('no seeded plans — migrations 0004/0008 should seed them');
  COMPARE_RESPONSE = [
    {
      plan_id: plan.id,
      plan_name: plan.name,
      retailer_id: plan.retailer_id,
      retailer_name: plan.retailer_name,
      projected_cost_cents: 210000,
      current_cost_cents: 260000,
      saving_cents: 50000,
      confidence: 0.9,
      recommendation: 'switch',
      reason: null,
    },
  ];
}

interface StubCall {
  url: string;
  body: unknown;
}

let calls: StubCall[];
let realFetch: typeof globalThis.fetch;

function stubFetch(overrides: Record<string, () => Response> = {}): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch { /* non-JSON body */ }
    calls.push({ url, body });

    for (const [fragment, make] of Object.entries(overrides)) {
      if (url.includes(fragment)) return make();
    }
    if (url.includes('/parse')) {
      return new Response(JSON.stringify(PARSE_RESPONSE), { status: 200 });
    }
    if (url.includes('/compare')) {
      return new Response(JSON.stringify(COMPARE_RESPONSE), { status: 200 });
    }
    // Sent messaging API, DeepSeek, anything else outbound.
    return new Response(JSON.stringify({ id: 'stub', status: 'sent' }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** Env for the queue consumers: real bindings + the stubbed service origins. */
function queueEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...env,
    PYTHON_SERVICE_URL: PYTHON,
    PYTHON_SERVICE_AUTH_TOKEN: 'test-token',
    SENT_API_KEY: 'test-sent-key',
    POWERSWITCH_LIVE: 'false', // seeded-plan path; the live bridge has its own suite
    ...overrides,
  };
}

/** Drive one message through the real queue consumer. */
async function runQueue(
  queueName: string,
  body: Record<string, unknown>,
  envOverrides: Record<string, unknown> = {}
): Promise<{ acked: boolean; retried: boolean }> {
  let acked = false;
  let retried = false;
  const batch = {
    queue: queueName,
    messages: [
      {
        id: 'msg-1',
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: () => { acked = true; },
        retry: () => { retried = true; },
      },
    ],
    ackAll: () => { acked = true; },
    retryAll: () => { retried = true; },
  } as unknown as MessageBatch<Record<string, unknown>>;

  const ctx = createExecutionContext();
  await worker.queue!(batch, queueEnv(envOverrides) as never, ctx);
  await waitOnExecutionContext(ctx);
  return { acked, retried };
}

async function seedUserWithBill(): Promise<{ userId: string; billId: string }> {
  const user = await createUser(env.DB, env as never, {
    phone: `+6421${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    name: 'E2E Tester',
  });
  const r2Key = `bills/${user.id}/e2e.pdf`;
  await env.BILLS.put(r2Key, new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF"
  const bill = await createBill(env.DB, {
    userId: user.id,
    rawR2Key: r2Key,
    source: 'gmail',
    sourceMessageId: `gmail_e2e_${crypto.randomUUID()}`,
  });
  return { userId: user.id, billId: bill.id };
}

beforeEach(async () => {
  calls = [];
  stubFetch();
  await buildCompareResponse();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('E2E: parse stage', () => {
  it('parses a bill, persists every field, and enqueues the comparison', async () => {
    const { userId, billId } = await seedUserWithBill();

    const { acked } = await runQueue('flip-parse-queue', {
      billId,
      r2Key: `bills/${userId}/e2e.pdf`,
      userId,
    });
    expect(acked, 'parse message must be acked').toBe(true);

    const bill = await getBillById(env.DB, billId);
    expect(bill?.status).toBe('parsed');
    expect(bill?.usageKwh).toBe(1113.88);
    expect(bill?.totalCents).toBe(39518);
    expect(bill?.cPerKwh).toBe(22.49);
    expect(bill?.cPerDay).toBe(291.0);
    expect(bill?.periodStart).toBe('2026-06-26');
    expect(bill?.periodEnd).toBe('2026-07-27');
    expect(bill?.days).toBe(32);
  });

  it('persists the bill address to the user so Powerswitch can resolve it', async () => {
    const { userId, billId } = await seedUserWithBill();

    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });

    const user = await getUserById(env.DB, env as never, userId);
    expect(
      user?.installationAddress,
      'installation_address drives the Powerswitch pxid lookup — without it the ' +
      'whole comparison falls back to seeded plans'
    ).toBe('14 KOWHAI STREET, BIRKDALE, AUCKLAND');
  });

  it('routes a low-confidence parse to needs_review instead of auto-accepting', async () => {
    const { userId, billId } = await seedUserWithBill();
    stubFetch({
      '/parse': () =>
        new Response(JSON.stringify({ ...PARSE_RESPONSE, confidence: 0.4 }), { status: 200 }),
    });

    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });

    const bill = await getBillById(env.DB, billId);
    expect(bill?.status).toBe('needs_review');
  });
});

describe('E2E: compare stage', () => {
  it('produces a comparison row from a parsed bill', async () => {
    const { userId, billId } = await seedUserWithBill();
    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });

    const { acked } = await runQueue('flip-compare-queue', {
      user_id: userId,
      bill_id: billId,
      parsed_at: new Date().toISOString(),
    });
    expect(acked).toBe(true);

    const row = await env.DB.prepare(
      'SELECT * FROM plan_comparisons WHERE user_id = ?1'
    ).bind(userId).first<Record<string, unknown>>();
    expect(row, 'compare stage must persist a plan_comparisons row').toBeTruthy();
  });

  it('sends the Python comparator a snake_case payload', async () => {
    const { userId, billId } = await seedUserWithBill();
    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });
    calls = [];
    await runQueue('flip-compare-queue', { user_id: userId, bill_id: billId });

    const compareCall = calls.find((c) => c.url.includes('/compare'));
    expect(compareCall, 'compare stage must call the Python comparator').toBeTruthy();
    const body = compareCall!.body as Record<string, unknown>;
    // A camelCase payload here 400'd against the live Python service.
    expect(Object.keys(body).join(','), 'payload must be snake_case').not.toMatch(/[a-z][A-Z]/);
  });
});

describe('E2E: full chain', () => {
  it('runs parse -> compare -> notify and delivers a message', async () => {
    const { userId, billId } = await seedUserWithBill();

    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });
    await runQueue('flip-compare-queue', { user_id: userId, bill_id: billId });

    const comparison = await env.DB.prepare(
      'SELECT id FROM plan_comparisons WHERE user_id = ?1 ORDER BY compared_at DESC'
    ).bind(userId).first<{ id: string }>();
    expect(comparison?.id).toBeTruthy();

    calls = [];
    const { acked } = await runQueue('flip-notify-queue', {
      userId,
      comparisonId: comparison!.id,
    });
    expect(acked).toBe(true);

    const sendCall = calls.find(
      (c) => !c.url.includes(PYTHON) && (c.url.includes('sent') || c.url.includes('message'))
    );
    expect(
      sendCall,
      `notify stage made no outbound send. Calls: ${calls.map((c) => c.url).join(', ') || '(none)'}`
    ).toBeTruthy();
  });
});

describe('E2E: notification guards', () => {
  /**
   * The single worst beta failure mode is spamming a real person. The dedup
   * (1h) and cooldown (7d) windows are the only thing preventing a re-queued
   * or retried notify message from sending twice, and both live in KV — so a
   * fully-mocked test cannot prove they work.
   */
  it('does not send twice for the same comparison', async () => {
    const { userId, billId } = await seedUserWithBill();
    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });
    await runQueue('flip-compare-queue', { user_id: userId, bill_id: billId });

    const comparison = await env.DB.prepare(
      'SELECT id FROM plan_comparisons WHERE user_id = ?1 ORDER BY compared_at DESC'
    ).bind(userId).first<{ id: string }>();
    expect(comparison?.id).toBeTruthy();

    // Count ACTUAL message dispatches only. The notify path also calls
    // DeepSeek to render copy, which is not a send.
    const sendsFor = (from: number) =>
      calls.slice(from).filter((c) => c.url.includes('/messages')).length;

    // Explicitly production-shaped: FLOW_TEST_MODE bypasses every guard below.
    const prod = { FLOW_TEST_MODE: 'false' };

    calls = [];
    await runQueue('flip-notify-queue', { userId, comparisonId: comparison!.id }, prod);
    const firstRun = sendsFor(0);
    expect(firstRun, 'first notify must send').toBeGreaterThan(0);

    const mark = calls.length;
    await runQueue('flip-notify-queue', { userId, comparisonId: comparison!.id }, prod);
    expect(
      sendsFor(mark),
      'second notify for the same comparison must be suppressed — a duplicate ' +
      'message to a real user is the worst beta failure mode'
    ).toBe(0);
  });
});

describe('E2E: failure handling', () => {
  /**
   * Beta will hit these. A misclassified failure either wedges the queue
   * (retrying a permanent error forever) or drops a recoverable bill on the
   * floor. Both are silent from the user's side, so they must be proven here.
   */
  it('retries a transient Python 5xx instead of dropping the bill', async () => {
    const { userId, billId } = await seedUserWithBill();
    stubFetch({ '/parse': () => new Response('upstream down', { status: 503 }) });

    const { acked, retried } = await runQueue('flip-parse-queue', {
      billId, r2Key: `bills/${userId}/e2e.pdf`, userId,
    });

    expect(retried, 'a 5xx is transient — the message must be retried').toBe(true);
    expect(acked, 'a transient failure must NOT be acked away').toBe(false);

    const bill = await getBillById(env.DB, billId);
    expect(bill?.status, 'bill must stay retryable, not be marked failed').not.toBe('failed');
  });

  it('fails a bill permanently on a Python 4xx rather than retrying forever', async () => {
    const { userId, billId } = await seedUserWithBill();
    stubFetch({ '/parse': () => new Response('unparseable', { status: 422 }) });

    const { acked, retried } = await runQueue('flip-parse-queue', {
      billId, r2Key: `bills/${userId}/e2e.pdf`, userId,
    });

    expect(retried, 'a 4xx is terminal — retrying it wedges the queue').toBe(false);
    expect(acked).toBe(true);

    const bill = await getBillById(env.DB, billId);
    expect(bill?.status).toBe('failed');
    expect(bill?.errorCode, 'a failed bill must carry a no-PII error code').toBeTruthy();
  });

  it('does not notify when the comparison shows no worthwhile saving', async () => {
    const { userId, billId } = await seedUserWithBill();
    await runQueue('flip-parse-queue', { billId, r2Key: `bills/${userId}/e2e.pdf`, userId });

    const noSaving = (COMPARE_RESPONSE as Record<string, unknown>[]).map((r) => ({
      ...r, saving_cents: 0, recommendation: 'stay_put', reason: 'no_savings',
    }));
    stubFetch({ '/compare': () => new Response(JSON.stringify(noSaving), { status: 200 }) });
    await runQueue('flip-compare-queue', { user_id: userId, bill_id: billId });

    const comparison = await env.DB.prepare(
      'SELECT id FROM plan_comparisons WHERE user_id = ?1 ORDER BY compared_at DESC'
    ).bind(userId).first<{ id: string }>();

    calls = [];
    await runQueue(
      'flip-notify-queue',
      { userId, comparisonId: comparison!.id },
      { FLOW_TEST_MODE: 'false' }
    );
    expect(
      calls.filter((c) => c.url.includes('/messages')).length,
      'a $0 saving must not trigger a WhatsApp message'
    ).toBe(0);
  });
});
