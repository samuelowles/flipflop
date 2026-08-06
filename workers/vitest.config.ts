import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The e2e suite needs migrations applied to a real D1 and has its own
    // config (vitest.e2e.config.ts). Running it here would fail on an empty
    // schema.
    exclude: ["**/node_modules/**", "**/dist/**", "src/e2e/**"],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["FLIP_KV"],
          d1Databases: ["flip-db"],
          r2Buckets: ["flip-bills"],
          queues: {
            consumers: {
              "flip-parse-queue": { maxBatchSize: 1, maxConcurrency: 3 },
              "flip-compare-queue": { maxBatchSize: 1, maxConcurrency: 2 },
              "flip-notify-queue": { maxBatchSize: 1, maxConcurrency: 5 },
            },
          },
        },
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});

