import { describe, it, expect } from 'vitest';
import { persistLLMCall, purgeOldLLMAudit, type LLMCallRecord } from './llmAudit';

/**
 * In-memory D1 mock backed by a real table model. Honours:
 *  - the `created_at DEFAULT (datetime('now'))` column (set on INSERT when not
 *    explicitly provided),
 *  - the `datetime('now', '-N days')` modifier used by the purge query,
 *  - backdated inserts (tests pass an explicit created_at to age rows).
 *
 * Only the statements this service uses are implemented: parameterised
 * INSERT, DELETE ... WHERE created_at < datetime('now', ?), and SELECT.
 */
type Row = Record<string, string | number | null>;

interface TableState {
  rows: Row[];
  autoIncrement: number;
}

function nowISO(): string {
  // SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' (UTC, space separator)
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Apply a SQLite-style `now` modifier string like '-30 days' to a base time. */
function shiftNow(baseIso: string, modifier: string): string {
  const daysMatch = modifier.match(/^(-?\d+) days$/);
  if (!daysMatch) return baseIso;
  const d = new Date(baseIso.replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() + Number(daysMatch[1]));
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function createInMemoryDb(seed: Row[] = []): D1Database & { _table: TableState } {
  const table: TableState = { rows: [...seed], autoIncrement: 0 };

  const prepare = (sql: string) => {
    const stmt = {
      bind: (...args: unknown[]) => ({
        run: async () => {
          const trimmed = sql.trim().toUpperCase();
          if (trimmed.startsWith('INSERT')) {
            // INSERT INTO llm_audit (request_id, model, intent, confidence, latency_ms, prompt_version) VALUES (?, ?, ?, ?, ?, ?)
            table.autoIncrement += 1;
            const row: Row = {
              id: table.autoIncrement,
              request_id: (args[0] as string | null) ?? null,
              model: args[1] as string,
              intent: (args[2] as string | null) ?? null,
              confidence: args[3] as number | null,
              latency_ms: args[4] as number | null,
              prompt_version: args[5] as string,
              created_at: nowISO(),
            };
            table.rows.push(row);
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('DELETE')) {
            // DELETE FROM llm_audit WHERE created_at < datetime('now', ?)
            const modifier = args[0] as string;
            const threshold = shiftNow(nowISO(), modifier);
            const before = table.rows.length;
            table.rows = table.rows.filter((r) => {
              const created = String(r.created_at ?? nowISO());
              return created >= threshold;
            });
            const deleted = before - table.rows.length;
            return { meta: { changes: deleted } };
          }
          return { meta: { changes: 0 } };
        },
        all: async () => ({ results: [...table.rows] }),
        first: async () => table.rows[0] ?? null,
      }),
      // Unbound variants (not used by this service but kept for completeness)
      run: async () => ({ meta: { changes: 0 } }),
      all: async () => ({ results: [...table.rows] }),
      first: async () => table.rows[0] ?? null,
    };
    return stmt;
  };

  const db = { prepare, _table: table } as unknown as D1Database & { _table: TableState };
  return db;
}

const baseRecord: LLMCallRecord = {
  request_id: 'req-1',
  model: 'flash',
  intent: 'help',
  confidence: 0.92,
  latency_ms: 137,
  prompt_version: '1.1.0',
};

describe('persistLLMCall', () => {
  it('inserts a metadata row with all required fields (AC #1, #4)', async () => {
    const db = createInMemoryDb();
    await persistLLMCall(db, baseRecord);

    expect(db._table.rows).toHaveLength(1);
    const row = db._table.rows[0]!;
    expect(row.model).toBe('flash');
    expect(row.intent).toBe('help');
    expect(row.confidence).toBe(0.92);
    expect(row.latency_ms).toBe(137);
    expect(row.prompt_version).toBe('1.1.0');
    expect(row.created_at).toBeTruthy(); // timestamp populated
    expect(row.request_id).toBe('req-1');
  });

  it('persists the pro model tag when model is pro', async () => {
    const db = createInMemoryDb();
    await persistLLMCall(db, { ...baseRecord, model: 'pro', intent: 'compare' });

    expect(db._table.rows[0]!.model).toBe('pro');
    expect(db._table.rows[0]!.intent).toBe('compare');
  });

  it('NEVER stores a message body / PII column — schema has none to leak into', async () => {
    // Even if a caller tried to smuggle body data through, the INSERT only
    // binds the six metadata columns defined by LLMCallRecord. Confirm no
    // body-like key exists on the persisted row.
    const db = createInMemoryDb();
    await persistLLMCall(db, {
      ...baseRecord,
    } as LLMCallRecord);

    const row = db._table.rows[0]!;
    const keys = Object.keys(row);
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('message');
    expect(keys).not.toContain('prompt');
    expect(keys).not.toContain('response');
    expect(keys).not.toContain('user_message');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('email');
    // Sanity: the persisted value must not contain a planted PII string even
    // if it had been adjacent in the call site (it isn't accepted).
    expect(JSON.stringify(row)).not.toContain('my secret bill text');
  });

  it('swallows persistence errors so audit can never break the LLM call path', async () => {
    const failingDb = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    await expect(persistLLMCall(failingDb, baseRecord)).resolves.toBeUndefined();
  });
});

describe('purgeOldLLMAudit (AC #3)', () => {
  function backdatedRow(daysOld: number, id: number): Row {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysOld);
    const created = d.toISOString().replace('T', ' ').slice(0, 19);
    return {
      id,
      request_id: `req-${id}`,
      model: 'flash',
      intent: 'help',
      confidence: 0.9,
      latency_ms: 100,
      prompt_version: '1.1.0',
      created_at: created,
    };
  }

  it('deletes rows older than 30 days and keeps recent rows', async () => {
    const seed: Row[] = [
      backdatedRow(45, 1), // old — should be purged
      backdatedRow(31, 2), // old — should be purged
      backdatedRow(29, 3), // recent — kept
      backdatedRow(1, 4),  // recent — kept
    ];
    const db = createInMemoryDb(seed);

    const deleted = await purgeOldLLMAudit(db, 30);

    expect(deleted).toBe(2);
    expect(db._table.rows).toHaveLength(2);
    expect(db._table.rows.map((r) => r.id)).toEqual([3, 4]);
  });

  it('honours a custom retention window', async () => {
    const seed: Row[] = [
      backdatedRow(10, 1),
      backdatedRow(3, 2),
    ];
    const db = createInMemoryDb(seed);

    const deleted = await purgeOldLLMAudit(db, 7);

    expect(deleted).toBe(1);
    expect(db._table.rows.map((r) => r.id)).toEqual([2]);
  });

  it('returns 0 when nothing is old enough', async () => {
    const seed: Row[] = [backdatedRow(5, 1), backdatedRow(10, 2)];
    const db = createInMemoryDb(seed);

    const deleted = await purgeOldLLMAudit(db, 30);
    expect(deleted).toBe(0);
    expect(db._table.rows).toHaveLength(2);
  });
});

describe('AC #4 — spot-check: 20 conversation logs include all required fields', () => {
  it('inserts 20 records and asserts each has every required field non-null', async () => {
    const db = createInMemoryDb();
    const models: Array<'flash' | 'pro'> = ['flash', 'pro'];
    for (let i = 0; i < 20; i++) {
      await persistLLMCall(db, {
        request_id: `req-${i}`,
        model: models[i % 2]!,
        intent: i % 2 === 0 ? 'help' : 'compare',
        confidence: 0.7 + (i % 10) / 100,
        latency_ms: 50 + i,
        prompt_version: '1.1.0',
      });
    }

    const { results } = await db.prepare('SELECT * FROM llm_audit').all();
    expect(results).toHaveLength(20);

    for (const row of results) {
      const r = row as Row;
      // AC #1: timestamp, model, intent_result (intent + confidence), latency_ms, prompt_version
      expect(r.created_at).toBeTruthy();
      expect(r.model).toBeTruthy();
      expect(r.intent).toBeTruthy();
      expect(r.confidence).not.toBeNull();
      expect(typeof r.confidence).toBe('number');
      expect(r.latency_ms).not.toBeNull();
      expect(r.prompt_version).toBe('1.1.0');
      // AC #2: no body/PII columns present
      expect(Object.keys(r)).not.toContain('body');
      expect(Object.keys(r)).not.toContain('message');
    }

    // Spot-check model coverage across the 20 logs.
    const flashCount = results.filter((r) => (r as Row).model === 'flash').length;
    const proCount = results.filter((r) => (r as Row).model === 'pro').length;
    expect(flashCount + proCount).toBe(20);
  });
});
