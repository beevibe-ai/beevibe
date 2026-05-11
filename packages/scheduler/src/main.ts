#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { readPositiveInt, resolveMcpServerUrl } from "@beevibe/core";
import { bootstrap } from "./bootstrap.js";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

async function main(): Promise<void> {
  // Load .env from CWD (production: env provided by orchestrator;
  // local dev: repo-root .env).
  loadEnv();

  const mcpServerUrl = resolveMcpServerUrl(process.env);

  const missing: string[] = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (!mcpServerUrl) missing.push("BEEVIBE_MCP_SERVER_URL");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  const { worker, cancelListener, healthServer, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    mcpServerUrl: mcpServerUrl!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    skillsSourceDir: process.env.BEEVIBE_SKILLS_DIR,
    pollIntervalMs: readPositiveInt(process.env.POLL_INTERVAL_MS, 0) || undefined,
    healthPort: readPositiveInt(process.env.BEEVIBE_SCHEDULER_HEALTH_PORT, 0) || undefined,
  });

  await cancelListener.start();
  await worker.start();
  await healthServer.start();
  console.error("[scheduler] ready");

  const stop = async (signal: string): Promise<void> => {
    console.error(`[scheduler] ${signal} received, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error("[scheduler] shutdown error:", err);
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
  console.error("[scheduler] fatal:", err);
  process.exit(1);
});
