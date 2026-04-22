import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { MemoryFact } from "../../domain/memory.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { CoreMemory } from "./core-memory.js";
import type { FactPromoter } from "./fact-promoter.js";
import type { FactStore } from "./fact-store.js";

/**
 * Similarity floor for briefing-time fact retrieval. Lower than the
 * merge threshold (0.88) because briefing wants recall breadth — we want
 * loosely-relevant facts to surface even when they aren't near-duplicates.
 */
const BRIEFING_RECALL_FLOOR = 0.35;
const DEFAULT_FACTS_PER_BRIEFING = 10;

export interface MemoryAgent {
  /** Pre-session: compose the `<core_memory>` + `<archival_memory>` XML block. */
  prepareBriefing(intent: string): Promise<string>;
  /** Post-session: promote facts written during this session if warranted. */
  onTaskComplete(sessionId: string): Promise<void>;
}

export interface MemoryAgentDeps {
  agentId: string;
  coreMemory: CoreMemory;
  factStore: FactStore;
  promoter: FactPromoter;
  embed: EmbeddingService;
  factsPerBriefing?: number;
}

/**
 * Session-scoped memory orchestrator.
 *
 * Stateless — session provenance travels on `memory_fact.source_session_ids`
 * so the executor can find a session's facts for promotion even when the
 * MCP server (which does the writes) lives in a different process.
 */
export function createMemoryAgent(deps: MemoryAgentDeps): MemoryAgent {
  const factsPerBriefing = deps.factsPerBriefing ?? DEFAULT_FACTS_PER_BRIEFING;

  return {
    async prepareBriefing(intent: string): Promise<string> {
      const [blocks, queryVec] = await Promise.all([
        deps.coreMemory.read(deps.agentId),
        deps.embed.embed(intent),
      ]);
      const facts = await deps.factStore.search({
        agent_id: deps.agentId,
        scope: ["ic", "team", "org"],
        embedding: queryVec,
        limit: factsPerBriefing,
        min_similarity: BRIEFING_RECALL_FLOOR,
      });
      return formatBriefing(blocks, facts);
    },

    async onTaskComplete(sessionId: string): Promise<void> {
      const facts = await deps.factStore.listBySessionId(sessionId);
      for (const fact of facts) {
        try {
          const result = await deps.promoter.evaluate(fact);
          if (result.promoted && result.target_scope !== null) {
            await deps.factStore.updateScope(fact.id, result.target_scope);
          }
        } catch (err) {
          console.error(
            `[MemoryAgent] promoter error for ${fact.id}:`,
            (err as Error).message,
          );
        }
      }
    },
  };
}

function formatBriefing(
  blocks: readonly CoreMemoryBlock[],
  facts: readonly MemoryFact[],
): string {
  const blockLines = blocks.map(
    (b) =>
      `  <block name="${escapeAttr(b.block_name)}">${escapeText(b.content)}</block>`,
  );
  const factLines = facts.map(
    (f) =>
      `  <fact type="${escapeAttr(f.fact_type)}" scope="${f.scope}">${escapeText(f.content)}</fact>`,
  );

  const lines = ["<core_memory>"];
  if (blockLines.length > 0) lines.push(...blockLines);
  lines.push("</core_memory>");
  lines.push("<archival_memory>");
  if (factLines.length > 0) lines.push(...factLines);
  lines.push("</archival_memory>");
  lines.push("<memory_tools>");
  lines.push("When you learn a durable fact, call save_memory(content, fact_type).");
  lines.push(
    "When your identity/focus shifts, call update_core_memory(block_name, operation, content[, old_content]).",
  );
  lines.push(
    "(These MCP tools are wired in M6. Before M6 lands, describe intended memory updates at the end of your response.)",
  );
  lines.push("</memory_tools>");
  return lines.join("\n");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
