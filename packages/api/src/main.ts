#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { bootstrap } from "./bootstrap.js";

const REQUIRED_ENV = ["DATABASE_URL"] as const;

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
