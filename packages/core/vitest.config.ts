import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    // Live-API tests (OpenAI embeddings / LLM providers, Anthropic LLM) make
    // real network calls and can be slow on cold CI runners. 30s absorbs
    // that variance without masking genuine deadlocks.
    testTimeout: 30_000,
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
