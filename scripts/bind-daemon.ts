#!/usr/bin/env node
/**
 * Bind the admin's team agent to a daemon's matching CLI runtime.
 *
 * Run after `daemon setup` so chat sends route through the daemon.
 * No-op when the agent is already bound or no daemon is registered.
 * `pnpm dev` calls this automatically.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";

const ADMIN_EMAIL = "admin@beevibe.local";

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(__dirname, "..");
  const ENV_PATH = join(REPO_ROOT, ".env");

  if (!existsSync(ENV_PATH)) {
    console.error("✗ .env missing — run `pnpm bootstrap` first");
    process.exit(1);
  }
  const env = parseDotenv(readFileSync(ENV_PATH, "utf-8"));
  process.env.DATABASE_URL = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!process.env.DATABASE_URL) {
    console.error("✗ DATABASE_URL missing from .env");
    process.exit(1);
  }

  const {
    createPool,
    PostgresPersonRepository,
    PostgresAgentRepository,
    PostgresDaemonRepository,
    PostgresRuntimeRepository,
  } = await import("../packages/core/src/adapters/postgres/index.js");

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const personRepo = new PostgresPersonRepository(pool);
  const agentRepo = new PostgresAgentRepository(pool);
  const daemonRepo = new PostgresDaemonRepository(pool);
  const runtimeRepo = new PostgresRuntimeRepository(pool);

  try {
    const person = await personRepo.findByEmail(ADMIN_EMAIL);
    if (!person) {
      console.log("no admin person yet — skipping bind");
      return;
    }
    const teamAgent = await agentRepo.findTopLevelForOwner(person.id);
    if (!teamAgent) {
      console.log("no team agent yet — skipping bind");
      return;
    }
    if (teamAgent.preferred_runtime_id) {
      console.log("team agent already bound");
      return;
    }
    const daemons = await daemonRepo.listActiveByOwner(person.id);
    if (daemons.length === 0) {
      console.log("no daemon registered — skipping bind");
      return;
    }
    const wantCli =
      (teamAgent.runtime_config as { type?: string } | null)?.type ?? "claude";
    for (const daemon of daemons) {
      const runtimes = await runtimeRepo.listByDaemon(daemon.id);
      const match = runtimes.find((r) => r.cli === wantCli);
      if (match) {
        await agentRepo.update(teamAgent.id, { preferred_runtime_id: match.id });
        console.log(`bound team agent → ${daemon.device_name} (${wantCli})`);
        return;
      }
    }
    console.log(
      `no daemon has a '${wantCli}' runtime — install ${wantCli} and re-run \`daemon setup\``,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
