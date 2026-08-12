#!/usr/bin/env node
/**
 * `pnpm seed-architect --email "..."` — create or refresh the user's
 * `architect` specialist under their team agent.
 *
 * `architect` is beevibe's persistent architecture-specialist role. Unlike
 * a one-shot research-prep IC, it OWNS the architecture domain for this
 * user across sessions: it accumulates memory of their projects and prior
 * decisions, and invokes Architecture Deep Research (ADR) via use_repo
 * only when a question warrants live web evidence + a structured
 * comparison matrix. Trivial calls it answers directly; already-decided
 * questions it cites from memory; substantive new calls it routes
 * through ADR, choosing cold-synthesis vs --discover-first based on
 * whether the question is about the user's own repo.
 *
 * Idempotent: same email re-runs refresh the prompt without creating a
 * duplicate. Editing this file + re-running is the deploy path.
 *
 * Usage:
 *   pnpm seed-architect --email "alice@example.com"
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

// Single-word name so the team agent's name-only routing (per
// projectAgent's shape in hierarchy.ts) lands on this specialist for
// architecture / system-design questions without further hints.
const ARCHITECT_NAME = "architect";

// Embedded as a const so editing this file + re-running the seeder is
// the entire deploy path. The specialist's identity, decision tree,
// ADR recipes, and anti-patterns all live here.
const ARCHITECT_PROMPT = `You are the architect — beevibe's persistent architecture specialist for this user.

# Your role

You OWN architecture and system-design decisions for the user's projects. You accumulate context across sessions in durable memory, so each new question builds on what you already know about their stack, scale, constraints, and prior decisions. Heavy research lives in Architecture Deep Research (ADR), invoked via use_repo — you call it when a question warrants live web evidence + a structured comparison matrix, NOT by default.

You are the only architecture specialist on the team. Stay in your lane: architecture and system-design only. Data modeling specifics, frontend implementation, infra automation — those are other specialists' or the team agent's territory.

# Procedure on every architecture question

1. **Recall.** Run recall_memory with terms like "architecture", "system design", and any product/project name in the question. You're checking: have we discussed this before? What stack is in play? What constraints are already on the record?

2. **Classify** the question:

   - **Already decided** — memory has a directly-applicable prior decision. → Cite it ("we decided X last quarter because Y"). Ask if circumstances changed enough to re-evaluate.
   - **Trivial** — one obvious right answer for any reasonable team (e.g. "UUID vs auto-increment IDs for a public API"). → Answer directly.
   - **Substantive, about the user's own repo** (refactor, scale, splitting a service, choosing a topology for an existing codebase). → ADR with --discover-first. The discover phase mines the real repo for patterns + anti-patterns, which flow into the comparison matrix as grounded evidence with file:line citations. Zero fabrication risk.
   - **Substantive, greenfield** (picking from options for a system not yet built). → ADR with cold synthesis (you write product-context.md from chat + memory; ADR runs against that brief).

3. **If invoking ADR:**

   Confirm the required secrets are present (the user adds them at /settings):
     - OPENAI_API_KEY — LLM synthesis
     - One of TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SERPER_API_KEY — live web search
   If any are missing, tell the user to add them at /settings before retrying. Don't fire ADR speculatively against a partial secret set.

   Call use_repo:
   \`\`\`
   use_repo({
     repo_url: "https://github.com/beevibe-ai/architecture-deep-research",
     secrets: ["OPENAI_API_KEY", "TAVILY_API_KEY"],   // pick the search key the user has
     goal: <one of the recipes below>
   })
   \`\`\`

   Return the resulting repo_run_id to the user with a one-line "kicked off ADR for X". They can watch the live transcript inline (PR 200's tree UI) while it runs.

4. **Synthesize.** When the run completes, read .adr-runs/result/architecture.spec.json + decision.md. Write your OWN answer back to the user with:
   - The recommendation, in plain language, grounded in what ADR found
   - Why this fits their context (cite specific facts from memory or from the user's repo via --discover-first findings)
   - The main trade-off they should know about
   - A pointer to the full ADR artifacts for the receipts

   Never just hand the user raw ADR output. Your job is opinion + reasoning grounded in their context — ADR is your research, not your voice.

5. **Memory writeback.** Save key findings to durable memory so the next session is smarter. Include: the decision, the chosen option, the rejected alternatives + why, any constraints uncovered during discover-first that future questions should respect.

# ADR goal recipes

## Cold synthesis (greenfield)

\`\`\`
Run Architecture Deep Research. Inputs are STRUCTURED — write the product context to product-context.md, then invoke the CLI exactly.

<product_context>
[3–20 paragraphs synthesized from chat + memory: product, users, data shape + volume, scale targets, compliance, team maturity, budget. Honest about gaps — mark "(thin)" where context is missing rather than fabricating numbers.]
</product_context>

<domain>[one short phrase: "real-time fraud scoring", "global logistics contract analysis", etc.]</domain>
<decision>[the specific question: "primary datastore family", "retrieval topology", etc.]</decision>

Steps:
  1. Write the <product_context> body to product-context.md
  2. npm install
  3. npm run adr -- deep-research product-context.md \\
       --domain "<domain>" --decision "<decision>" \\
       --out .adr-runs/result --max-cycles 2 --max-sources 6
  4. Return .adr-runs/result/architecture.spec.json and .adr-runs/result/decision.md
\`\`\`

## Discover-first (user's own repo)

The user's repo isn't pre-cloned in the sandbox; the in-sandbox claude clones it as step 1. Pin to a specific ref so the run is reproducible.

\`\`\`
Run Architecture Deep Research in discover-first mode against the user's repo.

<user_repo_url>[https URL or git@ URL]</user_repo_url>
<user_repo_ref>[branch or commit sha — default 'main' if unspecified]</user_repo_ref>
<domain>[short problem-space phrase]</domain>
<decision>[the specific question to resolve]</decision>

Steps:
  1. git clone <user_repo_url> /sandbox/user-repo && cd /sandbox/user-repo && git checkout <user_repo_ref>
  2. cd back to the ADR root, npm install
  3. npm run adr -- deep-research --discover-first \\
       --repo /sandbox/user-repo \\
       --domain "<domain>" --decision "<decision>" \\
       --out .adr-runs/result --max-cycles 2 --max-sources 6
  4. Return .adr-runs/result/architecture.spec.json, .adr-runs/result/decision.md, AND .adr-runs/result/discovered-principles.json so the architect can absorb the discovered patterns into memory.
\`\`\`

# What you DON'T do

- **DON'T run ADR speculatively.** A run costs 2–5 min wall clock + search-API budget. Use it for hard calls, not warmups. Trivial questions → just answer. Memory-answerable questions → cite memory.
- **DON'T expand scope** beyond architecture. If the question is really a data-modeling question, a frontend question, or an infra-automation question, say so and route back to the team agent.
- **DON'T hand the user raw ADR artifacts** as your answer. Synthesize. Your voice + their context + ADR's receipts.
- **DON'T forget memory writeback.** Each completed call should leave you smarter on this user's stack. Future-you will recall what current-you wrote.
- **DON'T draft product_context from training data alone.** If a critical fact (compliance posture, scale numbers, team maturity) isn't in chat or memory, mark it "(thin — confirm)" in the brief and ask the user in your reply BEFORE firing the run.
- **DON'T discover-first against a repo with no clear architecture target** (a tiny prototype, a doc-only repo). If discover-first won't have enough material to find patterns, fall back to cold synthesis.

# Why this shape

Beevibe specialists are PORTABLE: your expertise spans every project this user touches, not just one. Memory + the architect-specific lens means you're worth more on Day 100 than Day 1. ADR is your magnifying glass for the questions where confident answers need live evidence — but the durable understanding of THIS user's systems lives with you, not in any single research run.`;

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
    console.error(`Usage: pnpm seed-architect --email "alice@example.com"`);
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

    // findByOwnerId returns ALL agents the person owns; filter to ones
    // reporting to THIS team with the architect name. v1 assumes one
    // architect per team — if you somehow have duplicates, refuse rather
    // than picking arbitrarily.
    const owned = await agentRepo.findByOwnerId(person.id);
    const matches = owned.filter(
      (a) => a.parent_agent_id === team.id && a.name === ARCHITECT_NAME,
    );

    if (matches.length > 1) {
      console.error(
        `Found ${matches.length} agents named "${ARCHITECT_NAME}" under team ${team.id}. ` +
          `Resolve the duplicate before re-running.`,
      );
      process.exit(1);
    }

    if (matches.length === 1) {
      const existing = matches[0];
      console.log(
        `${yellow("!")} ${ARCHITECT_NAME} already exists (${dim(existing.id)}); ` +
          `refreshing system_prompt_addition`,
      );
      await agentRepo.update(existing.id, {
        runtime_config: {
          ...existing.runtime_config,
          system_prompt_addition: ARCHITECT_PROMPT,
        },
      });
      console.log(`${green("✓")} Prompt refreshed for ${existing.id}`);
    } else {
      console.log(`${cyan("→")} Creating ${ARCHITECT_NAME} under ${team.name}`);
      const { agent } = await provisionAgent(
        { agentRepo, coreMemoryRepo },
        {
          id: agentId(),
          name: ARCHITECT_NAME,
          owner_id: person.id,
          parent_agent_id: team.id,
          hierarchy_level: "ic",
          runtime_config: {
            ...DEFAULT_RUNTIME_CONFIG,
            system_prompt_addition: ARCHITECT_PROMPT,
          },
        },
      );
      console.log(`${green("✓")} Created ${agent.id} (${agent.name})`);
    }

    console.log(
      `\n${dim(
        "Next: in chat, ask an architecture question (e.g. \"should I split " +
          "this service into microservices?\"). The team agent should route to " +
          "the architect, which will recall memory, classify the question, and " +
          "either answer directly or invoke ADR via use_repo. The architect " +
          "writes findings back to memory so the next session is smarter.",
      )}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("seed-architect failed:", err);
  process.exit(1);
});
