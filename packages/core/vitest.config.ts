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
  },
});
