import { describe, it, expect } from 'vitest';
import { getBillsByUserId } from './bills';

/**
 * Every caller of getBillsByUserId treats `[0]` as "the user's current bill"
 * and reads the current plan's rates off it — and the entire savings figure is
 * driven by those rates (compareUserWithPowerswitch, planComparator,
 * notificationEngine all do this).
 *
 * The query used to order by `created_at DESC`, which is INGESTION order, not
 * billing order — and during the initial Gmail scan it is the exact reverse:
 * the scan walks search results newest-first, so the oldest bill is inserted
 * last and sorts first. The current plan was being read off the OLDEST bill.
 */
describe('getBillsByUserId ordering', () => {
  function captureSql(): { sql: string; db: D1Database } {
    let sql = '';
    const db = {
      prepare: (q: string) => {
        sql = q;
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    } as unknown as D1Database;
    return {
      get sql() {
        return sql;
      },
      db,
    };
  }

  it('orders by billing period, not ingestion time', async () => {
    const cap = captureSql();
    await getBillsByUserId(cap.db, 'user-1');

    expect(cap.sql).toContain('ORDER BY period_end DESC');
    expect(cap.sql).not.toMatch(/ORDER BY\s+created_at/);
  });

  it('breaks ties on created_at so ordering stays deterministic', async () => {
    const cap = captureSql();
    await getBillsByUserId(cap.db, 'user-1');

    expect(cap.sql).toContain('period_end DESC, created_at DESC');
  });
});
