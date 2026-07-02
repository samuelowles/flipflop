import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  isValidTransition,
  transitionSwitch,
  createSwitch,
  DuplicateActiveSwitchError,
} from './switchService';
import type { SwitchStatus } from '../types/switch';

/**
 * Issue #129 — switch state machine tests.
 *
 * Two surfaces:
 *   1. isValidTransition — pure predicate, every legal + illegal pair.
 *   2. transitionSwitch — boundary; happy path, illegal rejection, failure
 *      writes failure_reason, missing switch throws.
 *
 * Mock strategy: a tiny in-memory D1 that owns a `switches` map + a
 * `transitions` list and answers SELECT/UPDATE/INSERT by string-matching the
 * SQL (matches the captured-statement pattern used across workers/*.test.ts).
 */

const ALL_STATUSES: readonly SwitchStatus[] = [
  'requested',
  'confirmed',
  'in_progress',
  'completed',
  'failed',
];

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

/** Mutable internal row (D1 returns camelCase via rowToSwitch, but the store
 * holds the raw shape so the mock UPDATE path can mutate fields in place). */
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

function fakeDB(store: FakeStore): D1Database {
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          // SELECT * FROM switches WHERE id = ?N
          const id = params[0] as string;
          const row = store.switches.get(id);
          if (!row) return null;
          // rowToSwitch reads snake_case columns off the row.
          return row as unknown as T;
        },
        run: async () => {
          const trimmed = sql.trim();
          if (trimmed.startsWith('UPDATE switches')) {
            // SET clauses built dynamically; params are [status, ...extras, id]
            const id = params[params.length - 1] as string;
            const row = store.switches.get(id);
            if (!row) return { success: false, meta: { changes: 0 } };
            row.status = params[0] as SwitchStatus;
            if (sql.includes('confirmed_at')) row.confirmed_at = '2026-01-01T00:00:00.000Z';
            if (sql.includes('completed_at')) row.completed_at = '2026-01-01T00:00:00.000Z';
            if (sql.includes('failure_reason')) {
              // failure_reason is the last SET param before id
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

function seedSwitch(overrides: Partial<MutableSwitchRow> = {}): MutableSwitchRow {
  return {
    id: 'sw-1',
    user_id: 'u-1',
    from_retailer_id: 'ret-a',
    to_plan_id: 'plan-b',
    status: 'requested',
    requested_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: null,
    completed_at: null,
    failure_reason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. isValidTransition — pure predicate
// ---------------------------------------------------------------------------

describe('isValidTransition (issue #129 pure fn)', () => {
  it('allows every transition in ALLOWED_TRANSITIONS', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  });

  it('rejects every transition not in ALLOWED_TRANSITIONS', () => {
    // Build the full cross-product; every pair not allowlisted must reject.
    let illegalChecked = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (!ALLOWED_TRANSITIONS[from].includes(to)) {
          expect(isValidTransition(from, to)).toBe(false);
          illegalChecked++;
        }
      }
    }
    // 5x5 = 25 pairs. Legal (non-self) = 7, illegal non-self = 13, plus 5
    // self-transitions = 18 illegal pairs total.
    expect(illegalChecked).toBe(18);
  });

  it('rejects all self-transitions', () => {
    for (const s of ALL_STATUSES) {
      expect(isValidTransition(s, s)).toBe(false);
    }
  });

  it('treats null `from` as legal only to the start state (requested)', () => {
    expect(isValidTransition(null, 'requested')).toBe(true);
    for (const to of ALL_STATUSES) {
      if (to !== 'requested') {
        expect(isValidTransition(null, to)).toBe(false);
      }
    }
  });

  it('marks `failed` as terminal (no outgoing transitions)', () => {
    expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
    for (const to of ALL_STATUSES) {
      expect(isValidTransition('failed', to)).toBe(false);
    }
  });

  // Explicit table (cite AC #129):
  it('legal table matches AC #129', () => {
    expect(ALLOWED_TRANSITIONS.requested).toEqual(['confirmed', 'failed']);
    expect(ALLOWED_TRANSITIONS.confirmed).toEqual(['in_progress', 'failed']);
    expect(ALLOWED_TRANSITIONS.in_progress).toEqual(['completed', 'failed']);
    expect(ALLOWED_TRANSITIONS.completed).toEqual(['failed']);
    expect(ALLOWED_TRANSITIONS.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. transitionSwitch — boundary
// ---------------------------------------------------------------------------

describe('transitionSwitch (issue #129 boundary)', () => {
  it('happy path: requested -> confirmed -> in_progress -> completed, writing a transition row each step', async () => {
    const store: FakeStore = {
      switches: new Map([['sw-1', seedSwitch()]]),
      transitions: [],
    };
    const db = fakeDB(store);

    const step1 = await transitionSwitch(db, {
      switchId: 'sw-1',
      toStatus: 'confirmed',
      actor: 'user',
      reason: 'user confirmed',
    });
    expect(step1.status).toBe('confirmed');
    expect(step1.confirmedAt).not.toBeNull();

    const step2 = await transitionSwitch(db, {
      switchId: 'sw-1',
      toStatus: 'in_progress',
      actor: 'system',
    });
    expect(step2.status).toBe('in_progress');

    const step3 = await transitionSwitch(db, {
      switchId: 'sw-1',
      toStatus: 'completed',
      actor: 'webhook',
      reason: 'retailer acknowledged',
    });
    expect(step3.status).toBe('completed');
    expect(step3.completedAt).not.toBeNull();

    // Three transition rows, chained from->to with the right actor/reason.
    expect(store.transitions).toHaveLength(3);
    expect(store.transitions[0]).toMatchObject({
      switch_id: 'sw-1',
      from_status: 'requested',
      to_status: 'confirmed',
      actor: 'user',
      reason: 'user confirmed',
    });
    expect(store.transitions[1]).toMatchObject({
      from_status: 'confirmed',
      to_status: 'in_progress',
      actor: 'system',
      reason: null,
    });
    expect(store.transitions[2]).toMatchObject({
      from_status: 'in_progress',
      to_status: 'completed',
      actor: 'webhook',
    });
  });

  it('rejects an illegal transition (completed -> requested) and writes no transition row', async () => {
    const store: FakeStore = {
      switches: new Map([
        ['sw-1', seedSwitch({ status: 'completed', completed_at: '2026-01-02T00:00:00.000Z' })],
      ]),
      transitions: [],
    };
    const db = fakeDB(store);

    await expect(
      transitionSwitch(db, {
        switchId: 'sw-1',
        toStatus: 'requested',
        actor: 'cron',
      })
    ).rejects.toThrow(/Illegal switch transition: completed -> requested/);

    // Status unchanged, no audit row written.
    expect(store.switches.get('sw-1')!.status).toBe('completed');
    expect(store.transitions).toHaveLength(0);
  });

  it('failure path writes failure_reason onto the switch row', async () => {
    const store: FakeStore = {
      switches: new Map([['sw-1', seedSwitch({ status: 'confirmed' })]]),
      transitions: [],
    };
    const db = fakeDB(store);

    const result = await transitionSwitch(db, {
      switchId: 'sw-1',
      toStatus: 'failed',
      actor: 'webhook',
      reason: 'retailer rejected transfer',
      failureReason: 'Retailer rejected: invalid ICP number',
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('Retailer rejected: invalid ICP number');

    // Audit row carries the from->to + actor + reason.
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      from_status: 'confirmed',
      to_status: 'failed',
      actor: 'webhook',
      reason: 'retailer rejected transfer',
    });
  });

  it('throws when the switch does not exist', async () => {
    const store: FakeStore = { switches: new Map(), transitions: [] };
    const db = fakeDB(store);

    await expect(
      transitionSwitch(db, {
        switchId: 'nope',
        toStatus: 'confirmed',
        actor: 'user',
      })
    ).rejects.toThrow('Switch not found: nope');

    expect(store.transitions).toHaveLength(0);
  });

  it('does not clobber failure_reason when omitted on a non-failed transition', async () => {
    // confirmed -> in_progress after a prior failure_reason was set should
    // leave the column untouched (updateSwitchStatus only sets it when supplied).
    const store: FakeStore = {
      switches: new Map([
        ['sw-1', seedSwitch({ status: 'confirmed', failure_reason: 'pre-existing note' })],
      ]),
      transitions: [],
    };
    const db = fakeDB(store);

    const result = await transitionSwitch(db, {
      switchId: 'sw-1',
      toStatus: 'in_progress',
      actor: 'system',
    });
    expect(result.status).toBe('in_progress');
    // failureReason not in the SET clause this call → unchanged.
    expect(store.switches.get('sw-1')!.failure_reason).toBe('pre-existing note');
  });
});

// ---------------------------------------------------------------------------
// 3. createSwitch — issue #130 duplicate-active validation
//
// Extends the fakeDB to handle the model's INSERT INTO switches + the
// getActiveSwitchForUserAndPlan SELECT (user_id + to_plan_id + active statuses).
// ---------------------------------------------------------------------------

function fakeDB130(store: FakeStore): D1Database {
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          const trimmed = sql.trim();
          // getActiveSwitchForUserAndPlan: WHERE user_id AND to_plan_id AND active
          if (trimmed.includes('to_plan_id')) {
            const userId = params[0] as string;
            const planId = params[1] as string;
            const active: SwitchStatus[] = ['requested', 'confirmed', 'in_progress'];
            const found = [...store.switches.values()]
              .filter(
                (r) =>
                  r.user_id === userId &&
                  r.to_plan_id === planId &&
                  active.includes(r.status)
              )
              .sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1))[0];
            return (found as unknown as T) ?? null;
          }
          // getSwitchById: WHERE id
          if (trimmed.startsWith('SELECT * FROM switches WHERE id')) {
            const id = params[0] as string;
            const row = store.switches.get(id);
            return (row as unknown as T) ?? null;
          }
          return null;
        },
        run: async () => {
          const trimmed = sql.trim();
          // Model createSwitch INSERT. Status is a SQL literal ('requested'),
          // not a bind param — bind order is (id, userId, fromRetailerId, toPlanId, now).
          if (trimmed.startsWith('INSERT INTO switches')) {
            const row: MutableSwitchRow = {
              id: params[0] as string,
              user_id: params[1] as string,
              from_retailer_id: params[2] as string,
              to_plan_id: params[3] as string,
              status: 'requested',
              requested_at: params[4] as string,
              confirmed_at: null,
              completed_at: null,
              failure_reason: null,
            };
            store.switches.set(row.id, row);
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

describe('createSwitch (issue #130 validation)', () => {
  it('happy path: inserts switch + initial transition row (null -> requested, reason=created)', async () => {
    const store: FakeStore = { switches: new Map(), transitions: [] };
    const db = fakeDB130(store);

    const result = await createSwitch(db, {
      userId: 'u-1',
      fromRetailerId: 'ret-a',
      toPlanId: 'plan-b',
      actor: 'user',
    });

    expect(result.status).toBe('requested');
    expect(result.userId).toBe('u-1');
    expect(result.toPlanId).toBe('plan-b');

    // Exactly one switch row + one transition row.
    expect(store.switches.size).toBe(1);
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      switch_id: result.id,
      from_status: null,
      to_status: 'requested',
      actor: 'user',
      reason: 'created',
    });
  });

  it('duplicate rejection: active switch for same user+plan exists → throws DuplicateActiveSwitchError', async () => {
    const store: FakeStore = {
      switches: new Map([
        ['sw-existing', seedSwitch({ user_id: 'u-1', to_plan_id: 'plan-b', status: 'requested' })],
      ]),
      transitions: [],
    };
    const db = fakeDB130(store);

    await expect(
      createSwitch(db, {
        userId: 'u-1',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-b',
        actor: 'user',
      })
    ).rejects.toBeInstanceOf(DuplicateActiveSwitchError);

    // No new switch inserted, no new transition written.
    expect(store.switches.size).toBe(1);
    expect(store.transitions).toHaveLength(0);
  });

  it('duplicate rejection exposes the existing switch id (for HTTP 409 body)', async () => {
    const store: FakeStore = {
      switches: new Map([
        ['sw-existing', seedSwitch({ id: 'sw-existing', user_id: 'u-1', to_plan_id: 'plan-b', status: 'confirmed' })],
      ]),
      transitions: [],
    };
    const db = fakeDB130(store);

    await expect(
      createSwitch(db, {
        userId: 'u-1',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-b',
        actor: 'user',
      })
    ).rejects.toMatchObject({
      name: 'DuplicateActiveSwitchError',
      existingSwitchId: 'sw-existing',
    });
  });

  it('different-plan allowed: active switch for a DIFFERENT plan does NOT block', async () => {
    const store: FakeStore = {
      switches: new Map([
        ['sw-other', seedSwitch({ user_id: 'u-1', to_plan_id: 'plan-X', status: 'requested' })],
      ]),
      transitions: [],
    };
    const db = fakeDB130(store);

    const result = await createSwitch(db, {
      userId: 'u-1',
      fromRetailerId: 'ret-a',
      toPlanId: 'plan-b', // different plan
      actor: 'user',
    });

    // New switch created despite the existing active switch for a different plan.
    expect(store.switches.size).toBe(2);
    expect(result.toPlanId).toBe('plan-b');
    expect(store.transitions).toHaveLength(1);
  });

  it('terminal-status switch does NOT block: completed/failed switches are not "active"', async () => {
    const store: FakeStore = {
      switches: new Map([
        ['sw-done', seedSwitch({ user_id: 'u-1', to_plan_id: 'plan-b', status: 'completed' })],
        ['sw-failed', seedSwitch({ id: 'sw-failed', user_id: 'u-1', to_plan_id: 'plan-b', status: 'failed' })],
      ]),
      transitions: [],
    };
    const db = fakeDB130(store);

    const result = await createSwitch(db, {
      userId: 'u-1',
      fromRetailerId: 'ret-a',
      toPlanId: 'plan-b',
      actor: 'user',
    });

    expect(store.switches.size).toBe(3);
    expect(result.status).toBe('requested');
    expect(store.transitions).toHaveLength(1);
  });
});
