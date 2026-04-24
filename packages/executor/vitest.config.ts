import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Worker tests share the beevibe_test DB with core tests when both run.
    // Single fork + file parallelism disabled keeps TRUNCATE + query from
    // interleaving.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
  },
});
