import { describe, it, expect } from 'vitest';
import { getUsersByRetailer, updatePowerswitchLocation } from './users';

/**
 * Issue #75 — getUsersByRetailer returns just the IDs of users whose
 * current_retailer_id matches, for the plan-diff consumer. No PII is loaded.
 */

function fakeDB(rowsByRetailer: Record<string, { id: string }[]>): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (retailerId: string) => ({
        all: async () => ({
          results: rowsByRetailer[retailerId] ?? [],
          success: true,
          meta: {},
        }),
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    }),
  } as unknown as D1Database;
}

describe('getUsersByRetailer (issue #75)', () => {
  it('returns user ids for a matching retailer', async () => {
    const db = fakeDB({ contact: [{ id: 'u-1' }, { id: 'u-2' }] });
    const ids = await getUsersByRetailer(db, 'contact');
    expect(ids).toEqual(['u-1', 'u-2']);
  });

  it('returns an empty array when no users match', async () => {
    const db = fakeDB({});
    const ids = await getUsersByRetailer(db, 'nobody');
    expect(ids).toEqual([]);
  });

  it('does not match other retailers', async () => {
    const db = fakeDB({ contact: [{ id: 'u-1' }], mercury: [{ id: 'u-2' }] });
    const ids = await getUsersByRetailer(db, 'mercury');
    expect(ids).toEqual(['u-2']);
  });
});

/**
 * Issue #220 — updatePowerswitchLocation persists pxid + location id on the
 * user row. Captures the generated SQL + bind params so we can assert the
 * column names and that only the provided fields are written.
 */
describe('updatePowerswitchLocation (issue #220)', () => {
  function captureDB() {
    const stmts: { sql: string; params: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => {
            stmts.push({ sql, params });
            return { success: true, meta: {} };
          },
        }),
      }),
    } as unknown as D1Database;
    return { db, stmts };
  }

  it('writes both pxid and location id when both provided', async () => {
    const { db, stmts } = captureDB();
    await updatePowerswitchLocation(db, 'u-1', { pxid: 'px-1', locationId: '266' });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toContain('powerswitch_pxid');
    expect(stmts[0]!.sql).toContain('powerswitch_location_id');
    expect(stmts[0]!.sql).toContain('updated_at');
    // last param is the id
    expect(stmts[0]!.params[stmts[0]!.params.length - 1]).toBe('u-1');
  });

  it('writes only pxid when locationId is undefined', async () => {
    const { db, stmts } = captureDB();
    await updatePowerswitchLocation(db, 'u-1', { pxid: 'px-1' });
    expect(stmts[0]!.sql).toContain('powerswitch_pxid');
    expect(stmts[0]!.sql).not.toContain('powerswitch_location_id');
  });

  it('writes null when a field is explicitly null (clears the cache)', async () => {
    const { db, stmts } = captureDB();
    await updatePowerswitchLocation(db, 'u-1', { pxid: null, locationId: null });
    expect(stmts[0]!.params).toContain(null);
  });
});
