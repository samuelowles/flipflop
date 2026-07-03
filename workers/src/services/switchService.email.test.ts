import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSwitchFailureEmail,
  failSwitch,
} from './switchService';
import type { Switch, SwitchStatus } from '../types/switch';
import type { EmailEnv } from './email';

/**
 * Issue #132 — switch failure email fallback tests.
 *
 * Two surfaces:
 *   1. buildSwitchFailureEmail — pure fn, content correctness + PII stance.
 *   2. failSwitch — boundary: transitions to failed, sets reason, fires email,
 *      swallows email-send failure, log-only path when no API key.
 *
 * Reuses the in-memory D1 pattern from switchService.test.ts.
 */

function makeSwitch(overrides: Partial<Switch> = {}): Switch {
  return {
    id: 'sw-1',
    userId: 'u-1',
    fromRetailerId: 'ret-a',
    toPlanId: 'plan-b',
    status: 'confirmed',
    requestedAt: '2026-07-01T00:00:00.000Z',
    confirmedAt: '2026-07-01T00:00:00.000Z',
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory D1 fake — handles getSwitchById SELECT + UPDATE switches +
// INSERT switch_transitions (the only statements transitionSwitch issues).
// ---------------------------------------------------------------------------

interface MutableSwitchRow {
  id: string;
  user_id: string;
  from_retailer_id: string;
  to_plan_id: string;
  status: SwitchStatus;
  requested_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
}

interface FakeStore {
  switches: Map<string, MutableSwitchRow>;
  transitions: {
    id: string;
    switch_id: string;
    from_status: SwitchStatus | null;
    to_status: SwitchStatus;
    actor: string;
    reason: string | null;
    at: string;
  }[];
}

function fakeDB(store: FakeStore): D1Database {
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          const id = params[0] as string;
          const row = store.switches.get(id);
          return (row as unknown as T) ?? null;
        },
        run: async () => {
          const trimmed = sql.trim();
          if (trimmed.startsWith('UPDATE switches')) {
            const id = params[params.length - 1] as string;
            const row = store.switches.get(id);
            if (!row) return { success: false, meta: { changes: 0 } };
            row.status = params[0] as SwitchStatus;
            if (sql.includes('failure_reason')) {
              const frIdx = params.length - 2;
              row.failure_reason = (params[frIdx] as string | null) ?? null;
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT INTO switch_transitions')) {
            store.transitions.push({
              id: params[0] as string,
              switch_id: params[1] as string,
              from_status: params[2] as SwitchStatus | null,
              to_status: params[3] as SwitchStatus,
              actor: params[4] as string,
              reason: (params[5] as string | null) ?? null,
              at: params[6] as string,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: false, meta: { changes: 0 } };
        },
        all: async <T>() => ({ results: [] as unknown as T[], success: true, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
  return db;
}

function seedStore(switchOverrides: Partial<MutableSwitchRow> = {}): FakeStore {
  return {
    switches: new Map([
      [
        'sw-1',
        {
          id: 'sw-1',
          user_id: 'u-1',
          from_retailer_id: 'ret-a',
          to_plan_id: 'plan-b',
          status: 'confirmed',
          requested_at: '2026-07-01T00:00:00.000Z',
          confirmed_at: '2026-07-01T00:00:00.000Z',
          completed_at: null,
          failure_reason: null,
          ...switchOverrides,
        },
      ],
    ]),
    transitions: [],
  };
}

// ---------------------------------------------------------------------------
// 1. buildSwitchFailureEmail — pure fn
// ---------------------------------------------------------------------------

describe('buildSwitchFailureEmail (issue #132 pure fn)', () => {
  it('subject matches AC #132 verbatim ("Power switch ? manual steps needed")', () => {
    const { subject } = buildSwitchFailureEmail({
      switchRecord: makeSwitch(),
      reason: 'Retailer API timeout after retry',
    });
    // AC #132 "Subject: 'Power switch ? manual steps needed'" — preserved
    // verbatim (the `?` is the issue's emoji placeholder).
    expect(subject).toBe('Power switch ? manual steps needed');
  });

  it('body lists the 3 manual steps to complete the switch (AC #132)', () => {
    const { text } = buildSwitchFailureEmail({
      switchRecord: makeSwitch(),
      reason: 'x',
    });
    // Three numbered steps, retailer-site themed.
    expect(text).toMatch(/1\..*switch away/i);
    expect(text).toMatch(/2\..*plan details ready/i);
    expect(text).toMatch(/3\..*submit the switch request/i);
  });

  it('body includes switch id, opaque user_id, retailer/plan, and reason', () => {
    const { text } = buildSwitchFailureEmail({
      switchRecord: makeSwitch({ id: 'sw-42', userId: 'u-99' }),
      reason: 'Retailer rejected: invalid ICP',
      context: {
        fromRetailerName: 'Contact Energy',
        toRetailerName: 'Mercury',
        toPlanName: 'Good Energy Plan',
      },
    });
    expect(text).toContain('sw-42');
    expect(text).toContain('u-99');
    expect(text).toContain('Contact Energy');
    expect(text).toContain('Mercury');
    expect(text).toContain('Good Energy Plan');
    expect(text).toContain('Retailer rejected: invalid ICP');
  });

  it('falls back to ids when display-name context is omitted', () => {
    const { text } = buildSwitchFailureEmail({
      switchRecord: makeSwitch({
        fromRetailerId: 'ret-from',
        toPlanId: 'plan-to',
      }),
      reason: 'x',
    });
    expect(text).toContain('ret-from');
    expect(text).toContain('plan-to');
  });

  it('PII stance: NEVER includes raw phone, email, or name (ops-only)', () => {
    const { text, subject } = buildSwitchFailureEmail({
      switchRecord: makeSwitch({ userId: 'u-1' }),
      reason: 'x',
    });
    // The builder takes no PII fields, so any leak would be accidental. These
    // assertions are guardrails: they fail loudly if a future edit adds a
    // phone/email/name field to the email body.
    expect(text).not.toMatch(/\+64|0[2-9]\d{7,}/); // no NZ phone numbers
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // no email addresses
    // user_id IS allowed (opaque internal id), but it must be the literal id,
    // not a derived email. Sanity: subject never contains PII either.
    expect(subject).not.toMatch(/@|\+64|0[2-9]\d{7,}/);
  });

  it('includes an admin deep-link when adminBaseUrl is provided', () => {
    const { text } = buildSwitchFailureEmail({
      switchRecord: makeSwitch({ id: 'sw-7' }),
      reason: 'x',
      adminLink: { adminBaseUrl: 'https://admin.flip.nz/' },
    });
    expect(text).toContain('https://admin.flip.nz/switches/sw-7');
  });

  it('notes when admin URL is not configured', () => {
    const { text } = buildSwitchFailureEmail({
      switchRecord: makeSwitch(),
      reason: 'x',
    });
    expect(text).toContain('admin URL not configured');
  });

  it('bcc ops@flip is the job of failSwitch (sender), not the builder', () => {
    // The pure builder returns subject+text only — the bcc routing is set by
    // failSwitch when it calls sendEmail. This keeps the builder network-free.
    const email = buildSwitchFailureEmail({
      switchRecord: makeSwitch(),
      reason: 'x',
    });
    expect(email).not.toHaveProperty('bcc');
    expect(email).not.toHaveProperty('to');
  });
});

// ---------------------------------------------------------------------------
// 2. failSwitch — boundary
// ---------------------------------------------------------------------------

describe('failSwitch (issue #132 boundary)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('transitions the switch to failed with reason populated (AC #132)', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    const env = { RESEND_API_KEY: 'test-key' } as EmailEnv;

    const result = await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'Retailer API timeout after retry',
      actor: 'webhook',
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('Retailer API timeout after retry');
    expect(store.switches.get('sw-1')!.status).toBe('failed');
    expect(store.switches.get('sw-1')!.failure_reason).toBe(
      'Retailer API timeout after retry'
    );

    // One audit row from the transition.
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      switch_id: 'sw-1',
      from_status: 'confirmed',
      to_status: 'failed',
      actor: 'webhook',
      reason: 'Retailer API timeout after retry',
    });
  });

  it('fires the ops email (bcc ops@flip) after the transition succeeds', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 're_123' }), { status: 200 })
      );

    const env = { RESEND_API_KEY: 'test-key', OPS_EMAIL: 'ops@flip.nz' } as EmailEnv;

    await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'Retailer rejected',
      actor: 'webhook',
      opsTo: 'ops@flip.nz',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [url, init] = callArgs!;
    expect(String(url)).toBe('https://api.resend.com/emails');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.bcc).toBe('ops@flip.nz');
    expect(body.to).toBe('ops@flip.nz');
    expect(body.subject).toBe('Power switch ? manual steps needed');
    expect(body.text).toContain('sw-1');
    expect(body.text).toContain('Retailer rejected');

    fetchSpy.mockRestore();
  });

  it('failure-tolerance: email-send failure is swallowed, switch stays failed', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    // fetch throws — simulating a provider outage / network blip.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));

    const env = { RESEND_API_KEY: 'test-key' } as EmailEnv;

    // Must NOT throw — the state machine is already committed.
    const result = await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'Retailer timeout',
      actor: 'cron',
    });

    expect(result.status).toBe('failed');
    expect(store.switches.get('sw-1')!.status).toBe('failed');
    // The exception was logged as a structured line.
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/ops_email_exception|network down/);

    fetchSpy.mockRestore();
  });

  it('failure-tolerance: non-2xx provider response is swallowed, switch stays failed', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const env = { RESEND_API_KEY: 'bad-key' } as EmailEnv;

    const result = await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'x',
      actor: 'system',
    });

    expect(result.status).toBe('failed');
    expect(store.switches.get('sw-1')!.status).toBe('failed');
    fetchSpy.mockRestore();
  });

  it('inert path: missing RESEND_API_KEY → log-only, no fetch, switch still failed', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // No RESEND_API_KEY → inert.
    const env = {} as EmailEnv;

    const result = await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'Retailer rejected',
      actor: 'webhook',
    });

    expect(result.status).toBe('failed');
    expect(store.switches.get('sw-1')!.status).toBe('failed');
    // No provider call made.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Structured inert-log emitted instead.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/ops_email_inert/);
    expect(logged).toMatch(/RESEND_API_KEY unset/);

    fetchSpy.mockRestore();
  });

  it('does NOT send email if the transition itself fails (illegal)', async () => {
    // Seed a switch already in terminal `failed` state — failed->failed is illegal.
    const store = seedStore({ status: 'failed' });
    const db = fakeDB(store);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const env = { RESEND_API_KEY: 'test-key' } as EmailEnv;

    await expect(
      failSwitch(db, env, {
        switchId: 'sw-1',
        reason: 'x',
        actor: 'system',
      })
    ).rejects.toThrow(/Illegal switch transition: failed -> failed/);

    // Transition never committed → email never sent.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.transitions).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('uses display-name context in the email body when provided', async () => {
    const store = seedStore();
    const db = fakeDB(store);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 're_1' }), { status: 200 })
      );

    const env = { RESEND_API_KEY: 'test-key' } as EmailEnv;

    await failSwitch(db, env, {
      switchId: 'sw-1',
      reason: 'x',
      actor: 'webhook',
      context: {
        fromRetailerName: 'Contact Energy',
        toRetailerName: 'Mercury',
        toPlanName: 'Good Energy',
      },
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string
    );
    expect(body.text).toContain('Contact Energy');
    expect(body.text).toContain('Mercury');
    expect(body.text).toContain('Good Energy');

    fetchSpy.mockRestore();
  });
});
