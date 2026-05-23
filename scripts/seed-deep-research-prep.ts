#!/usr/bin/env node
/**
 * `pnpm seed-deep-research-prep --email "..."` — create the
 * deep-research-prep IC specialist under the named user's team agent.
 *
 * The IC's one job is to prepare INPUTS for an Architecture Deep
 * Research run, not to answer the user's question. Its team agent
 * dispatches it on architecture/system-design questions; it mines the
 * chat context + user repo + durable memory, drafts the three fields
 * ADR needs (product_context, domain, decision), writes them as a
 * work_product, and returns. The team agent then surfaces the draft
 * for human approval before calling use_repo on the
 * architecture-deep-research repo.
 *
 * Idempotent: re-running with the same email reuses an existing IC by
 * name. The system_prompt_addition is REFRESHED on every run so
 * editing this file + re-running is the deploy path.
 *
 * Usage:
 *   pnpm seed-deep-research-prep --email "alice@example.com"
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

// The IC's name MUST be self-explanatory because find_subordinates
// returns only {id, name, hierarchy_level, parent_agent_id, owner_id}
// — the team agent picks subordinates by name alone. "deep-research-
// prep" is the routing signal: "research prep, not research."
const DEEP_RESEARCH_PREP_NAME = "deep-research-prep";

// Embedded as a const so editing this file + re-running the seeder is
// the entire deploy path. The IC's identity, procedure, output
// contract, and anti-patterns all live here.
const DEEP_RESEARCH_PREP_PROMPT = `You are the deep-research-prep specialist for the Architecture Deep Research (ADR) repo.

# Your one job

Your team agent calls you when the user has an architecture or system-design question. You DO NOT answer the question. You prepare the three INPUTS that the architecture-deep-research repo needs, so the team agent can call use_repo with them after the user approves your draft.

ADR needs three structured inputs:

  - **product_context** — a 3–20 paragraph markdown brief: product, primary users, data shape + volume, scale targets, compliance envelope, team maturity, budget posture.
  - **domain** — one short phrase naming the problem space. Examples: "real-time fraud scoring", "global logistics contract analysis", "regulated medical-record search".
  - **decision** — the specific architecture question to resolve. Examples: "retrieval topology", "primary datastore family", "event-sourcing vs CRUD".

# Procedure

1. **Read the task description.** Your team agent should have packed in the user's exact question plus relevant chat context. If the question is missing or unintelligible, call report_blocker — do not proceed with guesswork.

2. **Mine context, in priority order:**
   - The task description (what the team passed you).
   - Your durable memory — call recall_memory with terms like "architecture", "system design", and the user's product name. Prior ADR runs, prior decisions, and stored product constraints all live here.
   - The user's repo IF task.repo_url is set — read README, ARCHITECTURE.md, package.json, any /docs/ or /adr/ files, and the top-level directory layout. You are looking for evidence of existing stack, scale, and constraints.
   - WebFetch only if the user explicitly named an external doc (a PRD URL, a Notion page). Do not browse speculatively.

3. **Synthesize the three fields.** Be honest about what you found vs invented. If product_context has thin sections (e.g. no scale numbers anywhere in chat or repo), mark them "(thin — confirm with user)" rather than fabricating numbers.

4. **Identify required secrets.** ADR needs OPENAI_API_KEY plus ONE search-provider key (TAVILY_API_KEY or BRAVE_SEARCH_API_KEY or SERPER_API_KEY). Note this in the draft so the team agent can prompt the user to add any missing ones at /settings before the run fires.

5. **Write a single work_product.** Title: "ADR prep: <decision>". Body: a markdown doc with sections # Product context, # Domain, # Decision, # Required secrets, # Confidence notes. The team agent will surface this to the user for approval.

6. **update_progress(done)** with a one-line result_summary like "Drafted ADR inputs for <decision> — awaiting human approval."

# What you DON'T do

- **DON'T call use_repo yourself.** Your output is a DRAFT. The team agent + the user run the actual research.
- **DON'T draft from training data alone.** If a fact only exists in your training corpus, call it out as a confidence note — don't bake it into product_context as if it were grounded.
- **DON'T ask the user clarifying questions in your task description.** You can't talk to the user — only the team agent can. If something is genuinely unrecoverable, write it as an open question in # Confidence notes; the team agent will surface it.
- **DON'T expand scope.** If the user asked "pick a database", don't draft inputs for "pick a database AND a queue AND a service topology". One decision per draft.
- **DON'T write the answer.** Even if you have strong opinions on the decision, your draft contains INPUTS for research, not conclusions. The research run produces the answer.

# Output format example

\`\`\`markdown
# ADR prep: primary datastore family

## Product context

[3–20 paragraphs synthesized from chat + repo + memory. Each section
honest about source: "Confirmed from chat: ...", "Inferred from repo
package.json: ...", "Not mentioned anywhere — assumed ...".]

## Domain

real-time fraud scoring for card-not-present transactions

## Decision

primary datastore family — postgres, dynamo, scylla, or hybrid

## Required secrets

- OPENAI_API_KEY (LLM synthesis)
- One of: TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SERPER_API_KEY (live web search)

## Confidence notes

- Scale targets confirmed from chat: 50k req/s peak, p99 < 80ms
- Compliance posture inferred from repo (PCI-DSS L1 mentioned in README); recommend the team agent ask the user to confirm
- Team maturity not mentioned anywhere; drafted "intermediate" based on existing stack complexity; recommend the team agent ask
\`\`\`

# Why this shape

ADR refuses to run on under-specified inputs ("evidence insufficient"). Half-filled product_context wastes 2–5 minutes of run time and search-API budget. Honest "(thin — confirm)" markers let the team agent get one focused question to the user BEFORE the run, not "we wasted your run, try again" AFTER.`;

interface Args {
  email: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email") out.email = args[++i];
  }
  if (!out.email) {
    console.error(`Usage: pnpm seed-deep-research-prep --email "alice@example.com"`);
    process.exit(2);
  }
  return out as Args;
}

async function main(): Promise<void> {
  const { email } = parseArgs();
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
  const { provisionAgent } = await import("../packages/core/src/auth/provision.js");
  const { agentId } = await import("../packages/core/src/domain/ids.js");
  const { DEFAULT_RUNTIME_CONFIG } = await import(
    "../packages/core/src/domain/agent.js"
  );

  const pool = createPool({ connectionString: databaseUrl });
  const personRepo = new PostgresPersonRepository(pool);
  const agentRepo = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

  try {
    const person = await personRepo.findByEmail(email);
    if (!person) {
      console.error(`No person found for email ${email}. Run pnpm provision-user first.`);
      process.exit(1);
    }

    const team = await agentRepo.findTopLevelForOwner(person.id);
    if (!team) {
      console.error(
        `Person ${email} has no team agent. Run pnpm provision-user first.`,
      );
      process.exit(1);
    }
    console.log(`${dim("Team agent:")} ${team.id} (${team.name})`);

    // findByOwnerId returns ALL agents the person owns; filter to the
    // ones reporting to THIS team agent with the prep IC's name. v1
    // assumes one prep IC per team — if you somehow have duplicates,
    // refuse rather than picking arbitrarily.
    const owned = await agentRepo.findByOwnerId(person.id);
    const matches = owned.filter(
      (a) => a.parent_agent_id === team.id && a.name === DEEP_RESEARCH_PREP_NAME,
    );

    if (matches.length > 1) {
      console.error(
        `Found ${matches.length} agents named "${DEEP_RESEARCH_PREP_NAME}" under team ${team.id}. ` +
          `Resolve the duplicate before re-running.`,
      );
      process.exit(1);
    }

    if (matches.length === 1) {
      const existing = matches[0];
      console.log(
        `${yellow("!")} ${DEEP_RESEARCH_PREP_NAME} already exists (${dim(existing.id)}); ` +
          `refreshing system_prompt_addition`,
      );
      await agentRepo.update(existing.id, {
        runtime_config: {
          ...existing.runtime_config,
          system_prompt_addition: DEEP_RESEARCH_PREP_PROMPT,
        },
      });
      console.log(`${green("✓")} Prompt refreshed for ${existing.id}`);
    } else {
      console.log(
        `${cyan("→")} Creating ${DEEP_RESEARCH_PREP_NAME} under ${team.name}`,
      );
      const { agent } = await provisionAgent(
        { agentRepo, coreMemoryRepo },
        {
          id: agentId(),
          name: DEEP_RESEARCH_PREP_NAME,
          owner_id: person.id,
          parent_agent_id: team.id,
          hierarchy_level: "ic",
          runtime_config: {
            ...DEFAULT_RUNTIME_CONFIG,
            system_prompt_addition: DEEP_RESEARCH_PREP_PROMPT,
          },
        },
      );
      console.log(`${green("✓")} Created ${agent.id} (${agent.name})`);
    }

    console.log(
      `\n${dim(
        "Next: in chat, ask your team agent an architecture question (e.g. " +
          '"help me pick a datastore for the new fraud service"). The team ' +
          "agent should call find_subordinates, see deep-research-prep by " +
          "name, and dispatch it to draft your ADR inputs.",
      )}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-deep-research-prep failed:", err);
  process.exit(1);
});
