import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  // The real bindings from wrangler.toml, plus the migrations handed in by
  // vitest.e2e.config.ts.
  interface ProvidedEnv {
    TEST_MIGRATIONS: D1Migration[];
    DB: D1Database;
    KV: KVNamespace;
    BILLS: R2Bucket;
    ENCRYPTION_KEY: string;
  }
}

// Build the real schema from the real migration files. If a migration is
// malformed this fails here — which is the point: the remote database has no
// migrations ledger, so a broken migration is otherwise only discovered by
// running it against production data.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * Re-activate the fabricated `source='manual'` seed plans for the calling
 * suite's database.
 *
 * Migration 0020 expires them so they cannot reach a real user. They remain a
 * legitimate FIXTURE: the pipeline suite drives the seeded-plan comparison path
 * (`POWERSWITCH_LIVE: 'false'`) and needs priceable plan rows to exercise it.
 * Opting in per-suite rather than in the shared setup keeps the production
 * truth assertable — `schema.e2e.test.ts` checks that migrations alone leave no
 * active manual plans.
 */
export async function activateSeedPlansForFixture(): Promise<void> {
  await env.DB.prepare(
    "UPDATE plans SET effective_to = NULL, is_current = 1 WHERE source = 'manual'"
  ).run();
}

/**
 * Undo {@link activateSeedPlansForFixture}, restoring what migration 0020 left.
 *
 * MUST be paired with it in an `afterEach`: this config runs every e2e file
 * against ONE database (`isolatedStorage: false`, `singleWorker: true`), so an
 * un-restored activation leaks into whichever file runs next — including the
 * schema suite's assertion that production has no active manual plans.
 */
export async function expireSeedPlansAfterFixture(): Promise<void> {
  await env.DB.prepare(
    "UPDATE plans SET effective_to = '2000-01-01T00:00:00Z', is_current = 0 " +
    "WHERE source = 'manual'"
  ).run();
}
