#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { bootstrap } from "./bootstrap.js";

// Both LLM provider keys are intentionally NOT required:
//   - OPENAI_API_KEY missing → memory recall/writes disabled; chat works
//   - ANTHROPIC_API_KEY missing → memory merge/promotion disabled; chat works
// Chat and tasks spawn the `claude` CLI, which authenticates via the
// host's `~/.claude/` credentials — no api key needed for those paths.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "BEEVIBE_MCP_SERVER_URL",
] as const;

async function main(): Promise<void> {
  loadEnv();

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  const port = process.env.BEEVIBE_API_PORT ? Number(process.env.BEEVIBE_API_PORT) : 3000;
  const { server, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    mcpServerUrl: process.env.BEEVIBE_MCP_SERVER_URL!,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    skillsSourceDir: process.env.BEEVIBE_SKILLS_DIR,
    port,
  });

  await server.start();
  console.error(`[api] ready on port ${port}`);

  const stop = async (signal: string): Promise<void> => {
    console.error(`[api] ${signal} received, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error("[api] shutdown error:", err);
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
  console.error("[api] fatal:", err);
  process.exit(1);
});
