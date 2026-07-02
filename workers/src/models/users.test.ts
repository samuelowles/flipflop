import { describe, it, expect } from 'vitest';
import { getUsersByRetailer } from './users';

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
