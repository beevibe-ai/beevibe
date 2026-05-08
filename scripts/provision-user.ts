#!/usr/bin/env node
/**
 * `pnpm provision-user --name "..." --email "..."` — mint a new
 * person + their primary team agent + a fresh `bv_u_` key.
 *
 * Usage:
 *   pnpm provision-user --name "Alice" --email "alice@example.com"
 *
 * Prints the freshly minted bv_u_ key to stdout. Once the web is
 * exposed externally, share this URL + key with the user and they sign
 * in via the web's /sign-in page. Each user gets their own team agent
 * (team-tier, hierarchy isolated by owner_id), so chat and
 * notifications stay scoped to their own work.
 *
 * Idempotent on email: if a person with this email already exists, we
 * print their existing key (and provision a team agent if missing).
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
loadDotenv({ path: join(REPO_ROOT, ".env") });

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface Args {
  name: string;
  email: string;
  agentName?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name") out.name = args[++i];
    else if (arg === "--email") out.email = args[++i];
    else if (arg === "--agent-name") out.agentName = args[++i];
  }
  if (!out.name || !out.email) {
    console.error(
      `Usage: pnpm provision-user --name "Alice" --email "alice@example.com"\n` +
        `Optional: --agent-name "Alice's team"`,
    );
    process.exit(2);
  }
  return out as Args;
}

async function main(): Promise<void> {
  const { name, email, agentName } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set — run pnpm bootstrap first or source .env");
    process.exit(2);
  }

  const {
    createPool,
    PostgresPersonRepository,
    PostgresAgentRepository,
    PostgresCoreMemoryRepository,
  } = await import("../packages/core/src/adapters/postgres/index.js");
  const { provisionAgent, provisionUser } = await import(
    "../packages/core/src/auth/provision.js"
  );
  const { personId, agentId } = await import("../packages/core/src/domain/ids.js");
  const { DEFAULT_RUNTIME_CONFIG } = await import(
    "../packages/core/src/domain/agent.js"
  );

  const pool = createPool({ connectionString: databaseUrl });
  const personRepo = new PostgresPersonRepository(pool);
  const agentRepo = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

  const teamAgentInput = {
    name: agentName ?? `${name}'s team`,
    hierarchy_level: "team" as const,
    runtime_config: DEFAULT_RUNTIME_CONFIG,
  };

  try {
    const existing = await personRepo.findByEmail(email);
    let key: string;
    let person_id: string;

    if (!existing?.api_key) {
      console.log(`${cyan("→")} Provisioning person ${dim(email)}`);
      const result = await provisionUser(
        { personRepo },
        { id: personId(), name, email },
      );
      key = result.apiKey;
      person_id = result.person.id;
      console.log(`${green("✓")} Person: ${dim(person_id)}`);
    } else {
      console.log(`${yellow("!")} Person ${dim(email)} already exists; reusing existing key`);
      key = existing.api_key;
      person_id = existing.id;
    }

    const existingTeam = await agentRepo.findTopLevelForOwner(person_id);
    if (existingTeam) {
      console.log(`${green("✓")} Team agent: ${dim(existingTeam.id)} (${existingTeam.name})`);
    } else {
      console.log(`${cyan("→")} Provisioning team agent`);
      const { agent } = await provisionAgent(
        { agentRepo, coreMemoryRepo },
        { ...teamAgentInput, id: agentId(), owner_id: person_id },
      );
      console.log(`${green("✓")} Team agent: ${dim(agent.id)} (${agent.name})`);
    }

    console.log(`\n${bold("API key:")} ${key}`);
    console.log(
      dim(
        "\nShare this key with the user. They sign in by pasting it into\n" +
          "the web's /sign-in page; it's stored in their browser only.\n",
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("provision-user failed:", err);
  process.exit(1);
});
