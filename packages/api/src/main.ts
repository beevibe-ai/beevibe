#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import {
  installShutdownHandlers,
  readPositiveInt,
  resolveRuntimeEnv,
  runEntrypoint,
} from "@beevibe/core";
import { bootstrap } from "./bootstrap.js";
import { parseAllowedOrigins } from "./cors.js";

async function main(): Promise<void> {
  loadEnv();

  const env = resolveRuntimeEnv(process.env);

  // Railway / Heroku-style PaaS injects PORT; honor it before falling back
  // to BEEVIBE_API_PORT (local dev) and then to 3000.
  const port = readPositiveInt(process.env.PORT ?? process.env.BEEVIBE_API_PORT, 3000);
  const corsAllowedOrigins = parseAllowedOrigins(process.env.BEEVIBE_CORS_ORIGINS);
  const { server, shutdown } = await bootstrap({
    ...env,
    corsAllowedOrigins,
    port,
  });

  await server.start();
  console.error(`[api] ready on port ${port}`);

  installShutdownHandlers("api", shutdown);
}

runEntrypoint("api", main);
