#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { bootstrap } from "./bootstrap.js";

// ANTHROPIC_API_KEY intentionally NOT required: when missing, the
// memory pipeline (FactStore merge / FactPromoter evaluate) silently
// no-ops. Task agents spawn the `claude` CLI for their LLM, which
// authenticates via the host's `~/.claude/` credentials.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "BEEVIBE_MCP_SERVER_URL",
  "OPENAI_API_KEY",
] as const;

async function main(): Promise<void> {
  // Load .env from CWD (production: env provided by orchestrator;
  // local dev: repo-root .env).
  loadEnv();

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  const { worker, cancelListener, healthServer, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    mcpServerUrl: process.env.BEEVIBE_MCP_SERVER_URL!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    pollIntervalMs: process.env.POLL_INTERVAL_MS
      ? Number(process.env.POLL_INTERVAL_MS)
      : undefined,
    healthPort: process.env.BEEVIBE_EXECUTOR_HEALTH_PORT
      ? Number(process.env.BEEVIBE_EXECUTOR_HEALTH_PORT)
      : undefined,
  });

  await cancelListener.start();
  await worker.start();
  await healthServer.start();
  console.error("[executor] ready");

  const stop = async (signal: string): Promise<void> => {
    console.error(`[executor] ${signal} received, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error("[executor] shutdown error:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

main().catch((err: unknown) => {
  console.error("[executor] fatal:", err);
  process.exit(1);
});
