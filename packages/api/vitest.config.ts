import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    // Integration tests (auth/middleware, routes/mcp) hit the shared
    // beevibe_test DB; parallel file execution would interleave TRUNCATE +
    // queries. Single-fork + serial files is mandatory.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
  },
});
