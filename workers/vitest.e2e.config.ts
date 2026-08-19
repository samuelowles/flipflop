import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

/**
 * End-to-end config — deliberately SEPARATE from vitest.config.ts.
 *
 * The unit suite (946 tests) mocks every binding, so nothing there ever runs
 * the real SQL against the real schema. That is the exact class of defect that
 * broke the last live run (FK violations, a camelCase payload the API rejected)
 * — all of it invisible to a fully-mocked suite.
 *
 * These tests instead run against a REAL D1 with every migration applied, real
 * KV, real R2 and the real queue consumers. Only outbound HTTP (Gmail, the
 * Python service, Powerswitch, Sent) is stubbed, because those are the genuine
 * trust boundaries.
 *
 * Kept separate so applying 19 migrations per file does not slow the unit
 * suite, and so a change here can never destabilise it.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "migrations")
  );

  return {
    test: {
      include: ["src/e2e/**/*.e2e.test.ts"],
      setupFiles: ["./src/e2e/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Per-test storage rollback cannot unlink its SQLite files on
          // Windows (EBUSY) and aborts the run. These tests seed a fresh user
          // per case and assert on that user's rows, so they do not need
          // rollback between tests.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              // Handed to the setup file, which applies them to env.DB.
              TEST_MIGRATIONS: migrations,

              // Fixed test key — NOT a secret, and deliberately checked in.
              //
              // createUser() encrypts phone numbers, so most of this suite
              // needs ENCRYPTION_KEY. It used to arrive from an untracked
              // .dev.vars, which meant the suite passed on a developer's
              // machine and died on any clean checkout with "Cannot read
              // properties of undefined (reading 'trim')" — a test that only
              // runs where someone already has the secret is not a gate.
              //
              // 64 hex characters = 32 bytes, the format both setup docs
              // specify (`openssl rand -hex 32`). The value is an obvious
              // pattern so it can never be mistaken for a real key, and it
              // only ever encrypts rows in a throwaway miniflare D1.
              ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            },
          },
        },
      },
    },
  };
});
