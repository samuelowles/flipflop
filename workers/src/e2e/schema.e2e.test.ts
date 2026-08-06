import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * Smoke test for the migration chain itself. Nothing in the 946-test unit suite
 * runs a single line of real SQL, so a broken migration or a drifted column
 * name reaches production unchallenged — and the remote database has no
 * migrations ledger, making a bad migration expensive to discover there.
 */
describe('migration chain', () => {
  it('applies every migration cleanly', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);

    for (const t of ['users', 'bills', 'retailers', 'plans', 'plan_comparisons']) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it('seeds the retailers the Gmail scan searches for', async () => {
    const { results } = await env.DB.prepare(
      'SELECT id, name, email_domains FROM retailers WHERE is_active = 1'
    ).all<{ id: string; name: string; email_domains: string | null }>();

    expect(results.length).toBeGreaterThanOrEqual(10);

    // Migration 0019 — Mercury's real billing sender domain.
    const mercury = results.find((r) => r.name === 'Mercury');
    expect(mercury?.email_domains).toContain('mercuryonline.co.nz');
  });

  it('carries the columns the pipeline writes', async () => {
    // Each of these was added by a later migration; a missing one breaks a
    // specific stage at runtime only.
    const checks: ReadonlyArray<[string, string]> = [
      ['users', 'installation_address'],
      ['users', 'powerswitch_pxid'],
      ['bills', 'source_message_id'],
      ['bills', 'error_code'],
      ['bills', 'period_end'],
    ];
    for (const [table, column] of checks) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?1`
      ).bind(column).first<{ n: number }>();
      expect(row?.n, `${table}.${column} missing`).toBe(1);
    }
  });
});
