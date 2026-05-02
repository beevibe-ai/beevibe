#!/usr/bin/env node
/**
 * `pnpm bootstrap` — first-run setup for a fresh clone.
 *
 * Walks the user from `git clone` to "running with a chat-ready team
 * agent" in one shell command:
 *
 *   1. Prompts for ANTHROPIC_API_KEY + OPENAI_API_KEY if .env is missing
 *      (or has placeholder values), writes .env from .env.example.
 *   2. Brings up postgres via docker compose if it isn't running, waits
 *      for pg_isready.
 *   3. Runs migrations (idempotent).
 *   4. Provisions an admin person (bv_u_ key) and a top-level team agent
 *      tied to them, IF none exist for the configured admin email.
 *   5. Writes the bv_u_ key into BOTH `.env` (so api/executor pick it up)
 *      AND `packages/web/.env.local` (Next.js doesn't read repo-root
 *      env files; without this the web shows "not connected").
 *   6. Tells the user to run `pnpm dev` — we don't spawn it ourselves so
 *      the user retains stdout / Ctrl+C semantics.
 *
 * The script is named `bootstrap` because `pnpm init` and `pnpm setup`
 * are both pnpm built-in commands (one creates a package.json, the
 * other configures pnpm itself by mutating ~/.zshrc) and would shadow
 * any same-named workspace script.
 *
 * Idempotent: re-running on a populated .env / postgres / db just
 * reports state and exits with no changes.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parse as parseDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");
const ENV_EXAMPLE_PATH = join(REPO_ROOT, ".env.example");
// Next.js doesn't read repo-root .env — its dev server only picks up
// .env.local within the package. Without this file the web shell can't
// see NEXT_PUBLIC_BV_USER_KEY and renders the "not connected" empty state.
const WEB_ENV_PATH = join(REPO_ROOT, "packages/web/.env.local");
const ADMIN_EMAIL_DEFAULT = "admin@beevibe.local";
const TEAM_AGENT_NAME_DEFAULT = "Team agent";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ok = (msg: string) => console.log(`  ${green("✓")} ${msg}`);
const info = (msg: string) => console.log(`  ${cyan("→")} ${msg}`);
const warn = (msg: string) => console.log(`  ${yellow("!")} ${msg}`);
const step = (n: number, msg: string) => console.log(`\n${bold(`Step ${n}.`)} ${msg}`);

async function main(): Promise<void> {
  console.log(`${bold("beevibe bootstrap")} — first-run setup\n`);
  console.log(dim("This will set up a local-only stack: postgres + api + executor + web."));
  console.log(dim("Re-running is safe; existing setup is detected and skipped.\n"));

  // ── Step 1: .env ─────────────────────────────────────────────────────────
  step(1, "Provider keys + .env");
  const env = await ensureEnvFile();

  // ── Step 2: docker postgres ─────────────────────────────────────────────
  step(2, "Postgres");
  await ensurePostgres();

  // ── Step 3: migrations ───────────────────────────────────────────────────
  step(3, "Migrations");
  runMigrations();

  // ── Step 4: provision admin + team agent ─────────────────────────────────
  step(4, "Admin user + team agent");
  // Imports happen here (after migrations + .env) so we can build adapters
  // against the running database with the right env loaded.
  process.env.DATABASE_URL = env.DATABASE_URL;
  const userKey = await ensureAdminAndTeamAgent();

  // ── Step 5: write NEXT_PUBLIC_BV_USER_KEY into .env ─────────────────────
  step(5, "Web key wiring");
  writeWebUserKey(userKey);

  // ── Step 6: next steps ───────────────────────────────────────────────────
  step(6, "Ready to start");
  console.log(`
  ${green("✓")} Setup complete. Start the stack:

      ${cyan("pnpm dev")}
      ${cyan("pnpm --filter @beevibe/web dev")}   ${dim("(in a second terminal)")}

  Then open ${cyan("http://localhost:3001")} (Next picks the next free port).
  Your bv_u_ key has been written to .env — keep it secret.
`);
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1: env
// ─────────────────────────────────────────────────────────────────────────

interface EnvState {
  DATABASE_URL: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  BEEVIBE_API_PORT: string;
  NEXT_PUBLIC_BV_API_URL: string;
  NEXT_PUBLIC_BV_USER_KEY: string;
  raw: Record<string, string>;
}

async function ensureEnvFile(): Promise<EnvState> {
  if (!existsSync(ENV_PATH)) {
    if (!existsSync(ENV_EXAMPLE_PATH)) {
      throw new Error(".env.example missing — can't bootstrap a fresh .env");
    }
    writeFileSync(ENV_PATH, readFileSync(ENV_EXAMPLE_PATH, "utf-8"));
    info("Created .env from .env.example");
  } else {
    info(".env exists — checking required keys");
  }

  const env = readEnv(ENV_PATH);

  const placeholderHints = ["placeholder", "fill-in", "your-key"];
  const looksLikePlaceholder = (v: string) =>
    placeholderHints.some((h) => v.toLowerCase().includes(h));

  const rl = readline.createInterface({ input, output });
  const ask = async (
    label: string,
    current: string | undefined,
    opts: { required?: boolean; help?: string } = {},
  ) => {
    const required = opts.required ?? true;
    // Required: prompt when missing/empty/placeholder.
    // Optional: prompt only when the value LOOKS like a placeholder (a
    // truly empty value means "user already chose to skip"; don't re-ask
    // on every bootstrap re-run).
    const needsPrompt = required
      ? !current || looksLikePlaceholder(current)
      : !!current && looksLikePlaceholder(current);
    if (!needsPrompt) return current ?? "";
    if (opts.help) console.log(`    ${dim(opts.help)}`);
    const prompt = required
      ? `    ${label} (required, paste): `
      : `    ${label} (optional, press Enter to skip): `;
    const value = (await rl.question(prompt)).trim();
    if (required && !value) {
      throw new Error(`${label} is required`);
    }
    return value;
  };

  const openai = await ask("OPENAI_API_KEY (sk-...)", env.OPENAI_API_KEY, {
    required: true,
    help: "Used for memory recall (text-embedding-3-small).",
  });
  const anthropic = await ask("ANTHROPIC_API_KEY (sk-ant-...)", env.ANTHROPIC_API_KEY, {
    required: false,
    help:
      "Optional — only used for memory fact merging + promotion. Chat and tasks " +
      "use the `claude` CLI directly (run `claude login` once).",
  });
  rl.close();

  env.OPENAI_API_KEY = openai;
  env.ANTHROPIC_API_KEY = anthropic;

  // Apply DATABASE_URL default if unset.
  env.DATABASE_URL ||= "postgresql://beevibe:beevibe@localhost:5433/beevibe";
  env.BEEVIBE_API_PORT ||= "3000";
  env.BEEVIBE_MCP_SERVER_URL ||= "http://localhost:3000/mcp";
  env.NEXT_PUBLIC_BV_API_URL ||= "http://localhost:3000";

  writeEnv(env);
  ok("Provider keys saved to .env");

  return {
    DATABASE_URL: env.DATABASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    BEEVIBE_API_PORT: env.BEEVIBE_API_PORT,
    NEXT_PUBLIC_BV_API_URL: env.NEXT_PUBLIC_BV_API_URL,
    NEXT_PUBLIC_BV_USER_KEY: env.NEXT_PUBLIC_BV_USER_KEY ?? "",
    raw: env,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2: postgres via docker compose
// ─────────────────────────────────────────────────────────────────────────

async function ensurePostgres(): Promise<void> {
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    throw new Error("Docker daemon isn't running. Start Docker Desktop and re-run.");
  }

  const ps = spawnSync("docker", ["compose", "ps", "--status", "running", "postgres"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  const alreadyRunning = ps.stdout.includes("postgres");
  if (alreadyRunning) {
    ok("Postgres already running");
  } else {
    info("Starting postgres via docker compose");
    execSync("docker compose up -d postgres", { cwd: REPO_ROOT, stdio: "inherit" });
    ok("Postgres started");
  }

  for (let i = 0; i < 30; i++) {
    const ready = spawnSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "beevibe", "-d", "beevibe"],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
    if (ready.status === 0) {
      ok(`pg_isready (${i + 1}s)`);
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  throw new Error("Postgres didn't become ready in 30s");
}

// ─────────────────────────────────────────────────────────────────────────
// Step 3: migrations
// ─────────────────────────────────────────────────────────────────────────

function runMigrations(): void {
  info("Applying migrations (node-pg-migrate)");
  execSync("pnpm migrate up", { cwd: REPO_ROOT, stdio: "inherit" });
  ok("Migrations up to date");
}

// ─────────────────────────────────────────────────────────────────────────
// Step 4: admin user + team agent
// ─────────────────────────────────────────────────────────────────────────

async function ensureAdminAndTeamAgent(): Promise<string> {
  const { createPool, PostgresPersonRepository, PostgresAgentRepository, PostgresCoreMemoryRepository } =
    await import("../packages/core/src/adapters/postgres/index.js");
  const { provisionAgent, provisionUser } = await import("../packages/core/src/auth/provision.js");
  const { personId, agentId } = await import("../packages/core/src/domain/ids.js");

  const pool = createPool({ connectionString: process.env.DATABASE_URL! });
  const personRepo = new PostgresPersonRepository(pool);
  const agentRepo = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

  const teamAgentInput = {
    name: TEAM_AGENT_NAME_DEFAULT,
    hierarchy_level: "team" as const,
    runtime_config: { type: "claude-code" as const, model: "claude-opus-4-7" },
  };

  try {
    const existing = await personRepo.findByEmail(ADMIN_EMAIL_DEFAULT);
    if (!existing?.api_key) {
      info("Provisioning admin person");
      const { person, apiKey } = await provisionUser(
        { personRepo },
        { id: personId(), name: "Admin", email: ADMIN_EMAIL_DEFAULT },
      );
      ok(`Admin user: ${dim(person.id)} (${dim(ADMIN_EMAIL_DEFAULT)})`);

      info("Provisioning team agent");
      const { agent } = await provisionAgent(
        { agentRepo, coreMemoryRepo },
        { ...teamAgentInput, id: agentId(), owner_id: person.id },
      );
      ok(`Team agent: ${dim(agent.id)}`);
      return apiKey;
    }

    ok(`Admin user already exists: ${dim(existing.id)}`);
    const existingTeam = await agentRepo.findTopLevelForOwner(existing.id);
    if (existingTeam) {
      ok(`Team agent already exists: ${dim(existingTeam.id)}`);
      return existing.api_key;
    }

    info("No team agent for existing admin — provisioning one");
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      { ...teamAgentInput, id: agentId(), owner_id: existing.id },
    );
    ok("Team agent provisioned");
    return existing.api_key;
  } finally {
    await pool.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 5: write web key into .env
// ─────────────────────────────────────────────────────────────────────────

function writeWebUserKey(userKey: string): void {
  // Root .env: api/executor read this. Keep it in sync so anything that
  // shells out can pick up the user key too.
  const env = readEnv(ENV_PATH);
  if (env.NEXT_PUBLIC_BV_USER_KEY !== userKey) {
    env.NEXT_PUBLIC_BV_USER_KEY = userKey;
    writeEnv(env);
    ok(`NEXT_PUBLIC_BV_USER_KEY written to .env: ${dim(userKey.slice(0, 12) + "…")}`);
  } else {
    ok("NEXT_PUBLIC_BV_USER_KEY already set in .env");
  }

  // packages/web/.env.local: Next.js's actual source of truth. Without
  // this the web shell renders "beevibe isn't connected yet" even though
  // the api server is up.
  const webEnv = existsSync(WEB_ENV_PATH) ? readEnv(WEB_ENV_PATH) : {};
  const apiUrl = env.NEXT_PUBLIC_BV_API_URL ?? "http://localhost:3000";
  if (webEnv.NEXT_PUBLIC_BV_USER_KEY === userKey && webEnv.NEXT_PUBLIC_BV_API_URL === apiUrl) {
    ok("packages/web/.env.local already in sync");
    return;
  }
  const webContents =
    `NEXT_PUBLIC_BV_API_URL=${apiUrl}\n` +
    `NEXT_PUBLIC_BV_USER_KEY=${userKey}\n`;
  writeFileSync(WEB_ENV_PATH, webContents);
  ok(`packages/web/.env.local written (web shell will pick up the key on next start)`);
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function readEnv(path: string): Record<string, string> {
  return parseDotenv(readFileSync(path, "utf-8"));
}

function writeEnv(env: Record<string, string>): void {
  const original = existsSync(ENV_EXAMPLE_PATH)
    ? readFileSync(ENV_EXAMPLE_PATH, "utf-8")
    : "";
  // Preserve comment structure from .env.example by rewriting line-by-line:
  // for each KEY=... line, substitute the current value from `env`. Lines
  // not in the example get appended at the end.
  const lines = original.split("\n");
  const seen = new Set<string>();
  const rewritten = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return raw;
    const eq = line.indexOf("=");
    if (eq === -1) return raw;
    const key = line.slice(0, eq).trim();
    seen.add(key);
    const value = env[key] ?? "";
    return `${key}=${value}`;
  });
  // Append any keys present in env that weren't in the example.
  for (const [k, v] of Object.entries(env)) {
    if (!seen.has(k)) rewritten.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, rewritten.join("\n"));
}

main().catch((err) => {
  console.error(`\n${bold("\x1b[31m✗\x1b[0m")} ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
