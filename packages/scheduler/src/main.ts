#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import {
  installShutdownHandlers,
  readPositiveInt,
  resolveRuntimeEnv,
  runEntrypoint,
} from "@beevibe/core";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  // Load .env from CWD (production: env provided by orchestrator;
  // local dev: repo-root .env).
  loadEnv();

  const env = resolveRuntimeEnv(process.env);

  const { worker, cancelListener, healthServer, shutdown } = await bootstrap({
    ...env,
    pollIntervalMs: readPositiveInt(process.env.POLL_INTERVAL_MS, 0) || undefined,
    healthPort: readPositiveInt(process.env.BEEVIBE_SCHEDULER_HEALTH_PORT, 0) || undefined,
  });

  await cancelListener.start();
  await worker.start();
  await healthServer.start();
  console.error("[scheduler] ready");

  installShutdownHandlers("scheduler", shutdown);
}

runEntrypoint("scheduler", main);
