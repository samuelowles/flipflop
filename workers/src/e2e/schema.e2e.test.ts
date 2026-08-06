import { env } from 'cloudflare:test';
import { createUser } from '../models/users';
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

describe('notification threshold is $200/year (migration 0021)', () => {
  /**
   * The threshold is compared against an ANNUAL saving, so the seeded 5000 was
   * "$50 per year" (~$4/month) — 4x below what PRD 5.3 intended. A bar that low
   * sits inside the comparison's own error margin (modelled TOU splits, assumed
   * discounts), so alerts could not be justified if a customer checked them.
   */
  it('creates new users at the $200/year default', async () => {
    const user = await createUser(env.DB, env as never, {
      phone: `+6421${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      name: 'Threshold Tester',
    });
    const row = await env.DB.prepare(
      'SELECT notification_threshold_cents AS c FROM users WHERE id = ?1'
    ).bind(user.id).first<{ c: number }>();
    // Proves the explicit bind works — the column DEFAULT is still 5000, so if
    // createUser ever stops binding it this silently regresses to $50/yr.
    expect(row?.c).toBe(20000);
  });

  it('leaves no user on the old seeded default after the migration chain', async () => {
    const stale = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE notification_threshold_cents = 5000'
    ).first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });
});
