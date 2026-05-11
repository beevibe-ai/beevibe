#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { bootstrap } from "./bootstrap.js";
import { parseAllowedOrigins } from "./cors.js";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "BEEVIBE_MCP_SERVER_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

async function main(): Promise<void> {
  loadEnv();

  // Railway-style PaaS injects RAILWAY_PUBLIC_DOMAIN for each service. If
  // the operator hasn't supplied BEEVIBE_MCP_SERVER_URL explicitly, derive
  // it from the public domain so daemons (and the agent CLIs they spawn)
  // hit this api's /mcp route without manual config.
  if (!process.env.BEEVIBE_MCP_SERVER_URL && process.env.RAILWAY_PUBLIC_DOMAIN) {
    process.env.BEEVIBE_MCP_SERVER_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/mcp`;
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. See .env.example for the full set.`,
    );
  }

  // Railway / Heroku-style PaaS injects PORT; honor it before falling back
  // to BEEVIBE_API_PORT (local dev) and then to 3000.
  const port = Number(process.env.PORT ?? process.env.BEEVIBE_API_PORT ?? 3000);
  const corsAllowedOrigins = parseAllowedOrigins(process.env.BEEVIBE_CORS_ORIGINS);
  const { server, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL!,
    mcpServerUrl: process.env.BEEVIBE_MCP_SERVER_URL!,
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
