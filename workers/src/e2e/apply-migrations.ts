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
