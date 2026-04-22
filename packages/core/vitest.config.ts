import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    // Integration tests share the beevibe_test database and run serially to avoid
    // interleaving TRUNCATE + query. Single-fork keeps it simple.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Test files share the beevibe_test DB; parallel file execution would
    // interleave TRUNCATE + queries and cause FK violations. Serial is
    // mandatory for integration tests, not just single-fork.
    fileParallelism: false,
  },
});
