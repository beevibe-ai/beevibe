/**
 * M3 end-to-end smoke. Exercises the full agent-driven memory pipeline
 * against live infrastructure.
 *
 * Requires:
 * - `RUN_M3_E2E=1`
 * - `DATABASE_URL_TEST` — pgvector-enabled Postgres (M0 schema + M3 migration)
 * - `OPENAI_API_KEY` — embeddings + fallback LLM
 * - `ANTHROPIC_API_KEY` — primary LLM (FactStore merge, FactPromoter)
 * - `claude` CLI on PATH (M2 runtime dependency)
 *
 * Usage:
 *   RUN_M3_E2E=1 pnpm tsx scripts/m3-e2e.ts
 *
 * What it does:
 *   1. Truncate test DB.
 *   2. Create a person + IC agent via AgentService (seeds 4 IC blocks).
 *   3. Write identity into the persona block via CoreMemory.
 *   4. Simulate two in-session facts via FactStore.addOrMerge.
 *   5. Build a briefing; sanity-check it contains blocks + facts.
 *   6. Provision a workspace; write an empty mcp-config.json.
 *   7. Run AgentSession with a trivial intent; assert status=succeeded.
 *   8. Simulate another fact save against the real session.id.
 *   9. Trigger post-session promotion; assert the method completes cleanly.
 *  10. Cleanup.
 */

import { config as loadEnv } from "dotenv";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { ClaudeCodeRuntime } from "../packages/core/src/adapters/claude-code/runtime.js";
import { AnthropicLlmProvider } from "../packages/core/src/adapters/anthropic/llm-provider.js";
import { OpenAIEmbeddingService } from "../packages/core/src/adapters/openai/embeddings.js";
import { createPool } from "../packages/core/src/adapters/postgres/client.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresMemoryFactRepository } from "../packages/core/src/adapters/postgres/memory-fact-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { PostgresSessionRepository } from "../packages/core/src/adapters/postgres/session-repo.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import { agentId, personId } from "../packages/core/src/domain/ids.js";
import { provisionAgent } from "../packages/core/src/auth/provision.js";
import { AgentSession } from "../packages/core/src/services/agent-session.js";
import { CoreMemory } from "../packages/core/src/services/memory/core-memory.js";
import { FactPromoter } from "../packages/core/src/services/memory/fact-promoter.js";
import { FactStore } from "../packages/core/src/services/memory/fact-store.js";
import { createMemoryAgent } from "../packages/core/src/services/memory/memory-agent.js";

const TABLES = [
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
  "agent",
  "person",
];

function step(n: number, title: string): void {
  console.log(`\n━━━ ${n}. ${title}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (process.env.RUN_M3_E2E !== "1") {
    console.log("Set RUN_M3_E2E=1 to run this script.");
    process.exit(0);
  }

  const dbUrl = process.env.DATABASE_URL_TEST;
  assert(dbUrl, "DATABASE_URL_TEST must be set");
  assert(process.env.OPENAI_API_KEY, "OPENAI_API_KEY must be set");
  assert(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY must be set");

  const pool = createPool({ connectionString: dbUrl, max: 4 });
  let workspacePath: string | undefined;

  try {
    step(1, "Truncate test DB");
    await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);

    step(2, "Create person + IC agent (via provisionAgent → initDefaults)");
    const persons = new PostgresPersonRepository(pool);
    const agents = new PostgresAgentRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    const factRepo = new PostgresMemoryFactRepository(pool);
    const sessions = new PostgresSessionRepository(pool);

    const owner = await persons.create({ id: personId(), name: "E2E Owner" });
    const { agent, blocks, apiKey } = await provisionAgent(
      { agentRepo: agents, coreMemoryRepo },
      {
        id: agentId(),
        name: "E2E IC",
        owner_id: owner.id,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const blockNames = blocks.map((b) => b.block_name).sort();
    console.log(`   agent ${agent.id} created with key ${apiKey.slice(0, 10)}… and blocks: ${blockNames.join(", ")}`);
    assert(blockNames.length === 4, "expected 4 IC default blocks");
    assert(apiKey.startsWith("bv_a_"), "agent key should have bv_a_ prefix");

    step(3, "Write identity into the persona block (CoreMemory.applyUpdate append)");
    const coreMemory = new CoreMemory({ repo: coreMemoryRepo });
    await coreMemory.applyUpdate(
      agent.id,
      "persona",
      "append",
      "Senior backend engineer focused on Postgres + pgvector.",
    );
    const readBack = await coreMemory.read(agent.id);
    const persona = readBack.find((b) => b.block_name === "persona");
    assert(persona && persona.content.includes("pgvector"), "persona not written");

    step(4, "Simulate in-session fact saves (FactStore.addOrMerge with a fake session id)");
    const embed = new OpenAIEmbeddingService();
    const llm = new AnthropicLlmProvider();
    const factStore = new FactStore({ repo: factRepo, embed, llm });
    const fakeSessionId = "sess_e2e_seed";
    const f1 = await factStore.addOrMerge(
      agent.id,
      fakeSessionId,
      "Prefers pnpm over npm for all node projects.",
      "preference",
    );
    const f2 = await factStore.addOrMerge(
      agent.id,
      fakeSessionId,
      "Uses Result<T,E> types for error handling rather than throwing.",
      "pattern",
    );
    console.log(`   facts: ${f1.id}, ${f2.id}`);
    assert(
      f1.source_session_ids.includes(fakeSessionId),
      "seeded fact missing session id",
    );

    step(5, "Build a briefing and sanity-check its XML shape");
    const promoter = new FactPromoter({ llm });
    const memoryAgent = createMemoryAgent({
      agentId: agent.id,
      coreMemory,
      factStore,
      promoter,
      embed,
    });
    // Query phrased to overlap with one of the seeded facts so retrieval
    // actually returns something — we want to prove the vector-search path works.
    const briefing = await memoryAgent.prepareBriefing(
      "Which node package manager should I use for this project?",
    );
    assert(briefing.includes("<core_memory>"), "briefing missing <core_memory>");
    assert(briefing.includes("pgvector"), "briefing missing persona content");
    assert(briefing.includes("<archival_memory>"), "briefing missing <archival_memory>");
    assert(briefing.includes("<fact"), "briefing missing <fact> element (vector recall failed)");
    assert(briefing.includes("pnpm"), "briefing missing the pnpm preference fact");
    assert(briefing.includes("save_memory"), "briefing missing memory_tools hint");
    console.log(`   briefing length: ${briefing.length} chars`);

    step(6, "Provision a workspace with an empty mcp-config.json");
    workspacePath = mkdtempSync(join(tmpdir(), "beevibe-m3-e2e-"));
    writeFileSync(
      join(workspacePath, "mcp-config.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    step(7, "Run AgentSession through the real Claude CLI");
    const runtime = new ClaudeCodeRuntime({ maxTurns: 1 });
    const session = new AgentSession({
      agentRepo: agents,
      sessionRepo: sessions,
      runtime,
      memoryAgent,
    });
    const result = await session.run({
      agentId: agent.id,
      intent: "Reply with the single word 'ok'.",
      urgency: "low",
      workspace: { path: workspacePath },
    });
    console.log(
      `   session ${result.id} → status=${result.status}, cli_session=${result.cli_session_id}`,
    );
    assert(result.status === "succeeded", "session did not succeed");
    assert(result.cli_session_id, "cli_session_id missing");
    assert(
      result.usage?.input_tokens && result.usage.input_tokens > 0,
      "usage.input_tokens not recorded",
    );

    step(8, "Simulate another fact save with the real session.id");
    const f3 = await factStore.addOrMerge(
      agent.id,
      result.id,
      "Project uses Turborepo caching with the remote cache disabled.",
      "gotcha",
    );
    assert(f3.source_session_ids.includes(result.id), "session id not stamped on fact");

    step(9, "Trigger post-session promotion (MemoryAgent.onTaskComplete)");
    await memoryAgent.onTaskComplete(result.id);
    const f3After = await factRepo.findById(f3.id);
    console.log(
      `   post-promotion scope for ${f3.id}: ${f3After?.scope} (originally ic)`,
    );

    console.log("\n✓ M3 E2E complete");
  } finally {
    if (workspacePath) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("\n✗ M3 E2E failed:", err);
  process.exit(1);
});
