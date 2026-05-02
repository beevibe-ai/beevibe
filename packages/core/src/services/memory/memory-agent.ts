import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { MemoryFact, MemoryScope } from "../../domain/memory.js";
import type { SessionBriefingSnapshot } from "../../domain/session.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import { promotionEventId } from "../../domain/ids.js";
import type { MemoryPromotionEventRepository } from "../../ports/promotion-event-repo.js";
import type { CoreMemory } from "./core-memory.js";
import type { FactPromoter, PromotionResult } from "./fact-promoter.js";
import type { FactStore } from "./fact-store.js";

/**
 * Similarity floor for briefing-time fact retrieval. Lower than the
 * merge threshold (0.88) because briefing wants recall breadth — we want
 * loosely-relevant facts to surface even when they aren't near-duplicates.
 */
const BRIEFING_RECALL_FLOOR = 0.35;
const DEFAULT_FACTS_PER_BRIEFING = 10;

export interface BriefingResult {
  /** XML block appended to the agent's system prompt. */
  systemPromptAppend: string;
  /** Structured snapshot persisted on the session row for the UI to render. */
  snapshot: SessionBriefingSnapshot;
}

export interface MemoryAgent {
  /**
   * Pre-session: compose the `<core_memory>` + `<archival_memory>` XML block.
   * Returns both the assembled prompt string AND a structured snapshot
   * for persistence on the session row.
   */
  prepareBriefing(intent: string): Promise<BriefingResult>;
  /** Post-session: promote facts written during this session if warranted. */
  onTaskComplete(sessionId: string): Promise<void>;
}

export interface MemoryAgentDeps {
  agentId: string;
  coreMemory: CoreMemory;
  factStore: FactStore;
  promoter: FactPromoter;
  /**
   * Embedding service for briefing-time fact recall. Optional: when
   * absent, `prepareBriefing` returns blocks-only (no vector search).
   * Memory writes via the MCP `save_memory` tool also fail-fast in
   * `FactStore.addOrMerge` — the tool surfaces a friendly disabled
   * message to the agent.
   */
  embed?: EmbeddingService;
  /**
   * Optional audit log for FactPromoter decisions. When provided,
   * `onTaskComplete` writes a row per evaluated fact (promoted + rejected)
   * so the Promotions page can surface the LLM's reasoning.
   */
  promotionEventRepo?: MemoryPromotionEventRepository;
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
    async prepareBriefing(intent: string): Promise<BriefingResult> {
      // Without an embedding service we can't do vector recall — return
      // a blocks-only briefing. Core memory still works, archival memory
      // is empty for this session. The agent operates without recall
      // until the operator provides an OPENAI_API_KEY and writes start
      // landing in memory_fact again.
      if (!deps.embed) {
        const blocks = await deps.coreMemory.read(deps.agentId);
        return composeBriefing(blocks, []);
      }
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
      return composeBriefing(blocks, facts);
    },

    async onTaskComplete(sessionId: string): Promise<void> {
      const facts = await deps.factStore.listBySessionId(sessionId);
      // Each iteration runs sequentially because `promoter.evaluate` is an
      // LLM call and we want serialized rate-limit behavior. Audit writes
      // are batched after the loop so they don't extend the LLM-bound tail.
      const decisions: Array<{ fact: MemoryFact; result: PromotionResult; fromScope: MemoryScope }> = [];
      for (const fact of facts) {
        try {
          const result = await deps.promoter.evaluate(fact);
          const fromScope = fact.scope;
          if (result.promoted && result.target_scope !== null) {
            await deps.factStore.updateScope(fact.id, result.target_scope);
          }
          decisions.push({ fact, result, fromScope });
        } catch (err) {
          console.error(
            `[MemoryAgent] promoter error for ${fact.id}:`,
            (err as Error).message,
          );
        }
      }

      const repo = deps.promotionEventRepo;
      if (!repo || decisions.length === 0) return;

      // Audit row reflects actual movement: rejected events keep
      // to_scope = from_scope so the page can show "kept narrow".
      const writes = decisions.map(({ fact, result, fromScope }) =>
        repo.create({
          id: promotionEventId(),
          fact_id: fact.id,
          from_scope: fromScope,
          to_scope: result.promoted && result.target_scope ? result.target_scope : fromScope,
          origin_agent_id: fact.agent_id,
          promoter_reason: result.reason,
          source_session_ids: fact.source_session_ids,
          rejected: !result.promoted,
        }),
      );
      const results = await Promise.allSettled(writes);
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          const factId = decisions[i]?.fact.id ?? "?";
          console.error(
            `[MemoryAgent] audit write failed for ${factId}:`,
            (r.reason as Error).message,
          );
        }
      }
    },
  };
}

/** Coarse ~4 chars/token estimate for the UI's "tokens used" header. */
const PREVIEW_CHARS = 80;

/**
 * Single-pass composer for the briefing XML + structured snapshot. One
 * iteration over blocks + facts produces both the system-prompt append
 * (consumed by the runtime) and the persisted snapshot (consumed by the
 * session detail page).
 */
function composeBriefing(
  blocks: readonly CoreMemoryBlock[],
  facts: readonly MemoryFact[],
): BriefingResult {
  const blockLines: string[] = [];
  const blockSnapshots: SessionBriefingSnapshot["blocks"] = [];
  let charTotal = 0;
  for (const b of blocks) {
    blockLines.push(
      `  <block name="${escapeAttr(b.block_name)}">${escapeText(b.content)}</block>`,
    );
    blockSnapshots.push({
      name: b.block_name,
      chars: b.content.length,
      preview: b.content.slice(0, PREVIEW_CHARS),
    });
    charTotal += b.content.length;
  }

  const factLines: string[] = [];
  const factSnapshots: SessionBriefingSnapshot["facts"] = [];
  for (const f of facts) {
    factLines.push(
      `  <fact type="${escapeAttr(f.fact_type)}" scope="${f.scope}">${escapeText(f.content)}</fact>`,
    );
    factSnapshots.push({
      scope: f.scope,
      content: f.content,
      // FactStore doesn't currently round-trip similarity score on the
      // returned MemoryFact. Backfill 0 until plumbed end-to-end.
      score: 0,
    });
    charTotal += f.content.length;
  }

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

  return {
    systemPromptAppend: lines.join("\n"),
    snapshot: {
      block_count: blocks.length,
      fact_count: facts.length,
      token_count: Math.ceil(charTotal / 4),
      blocks: blockSnapshots,
      facts: factSnapshots,
    },
  };
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
