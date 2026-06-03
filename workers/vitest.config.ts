import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
  },
});
