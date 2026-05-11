#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { readPositiveInt, resolveMcpServerUrl } from "@beevibe/core";
import { bootstrap } from "./bootstrap.js";
import { parseAllowedOrigins } from "./cors.js";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

async function main(): Promise<void> {
  loadEnv();

  const mcpServerUrl = resolveMcpServerUrl(process.env);

  const missing: string[] = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (!mcpServerUrl) missing.push("BEEVIBE_MCP_SERVER_URL");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  // Railway / Heroku-style PaaS injects PORT; honor it before falling back
  // to BEEVIBE_API_PORT (local dev) and then to 3000.
  const port = readPositiveInt(process.env.PORT ?? process.env.BEEVIBE_API_PORT, 3000);
  const corsAllowedOrigins = parseAllowedOrigins(process.env.BEEVIBE_CORS_ORIGINS);
  const { server, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    mcpServerUrl: mcpServerUrl!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    skillsSourceDir: process.env.BEEVIBE_SKILLS_DIR,
    corsAllowedOrigins,
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
