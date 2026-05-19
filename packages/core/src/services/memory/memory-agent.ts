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
  /**
   * XML block appended to the agent's system prompt. Contains
   * `<core_memory>` only — the stable per-agent slice. Cache-friendly
   * across sessions of the same agent (M9.4).
   */
  systemPromptAppend: string;
  /**
   * XML block prepended to the user's first message (the `intent`).
   * Contains `<archival_memory>` — the per-session top-k vector recall.
   * Lives in the user prompt rather than system prompt because vector
   * hits change every session and would otherwise bust the system-prompt
   * cache for everything that follows (M9.4 — per Claude Code's own
   * engineering guidance: "use messages instead of system prompt for
   * varying content").
   *
   * Empty string when there are no archival facts to surface.
   */
  userMessagePrefix: string;
  /** Structured snapshot persisted on the session row for the UI to render. */
  snapshot: SessionBriefingSnapshot;
}

export interface MemoryAgent {
  /**
   * Pre-session: compose the `<core_memory>` (system) + `<archival_memory>`
   * (user-message) XML blocks. Splits along the stability axis so the
   * stable system-prompt portion can be cached across sessions; the
   * per-session retrieval lives in the user message instead.
   *
   * Returns both prompt strings AND a structured snapshot for persistence
   * on the session row.
   */
  prepareBriefing(intent: string): Promise<BriefingResult>;
  /**
   * Session-start briefing for surfaces that have no intent at init time
   * (human MCP — the user hasn't said anything yet). Returns the same
   * `BriefingResult` shape as `prepareBriefing` but with an empty
   * `userMessagePrefix` and zero facts in the snapshot.
   *
   * Skips the OpenAI embed + pgvector query entirely — there's no signal
   * to query against, so any retrieval would be noise. The caller's CLI
   * uses the `search_context` MCP tool to pull archival facts on demand
   * when it realizes it needs them.
   */
  prepareCoreOnly(): Promise<BriefingResult>;
  /**
   * Mid-session: vector-search the agent's archival facts by `query` and
   * return ONLY the `<archival_memory>...</archival_memory>` XML envelope.
   * Used by the `search_context` MCP tool — the agent already has its
   * core_memory blocks in its system prompt, so re-rendering them on every
   * search would be redundant DB work plus noise in the tool result.
   *
   * Always returns a non-empty XML envelope; on no hits, returns an empty
   * `<archival_memory></archival_memory>` so the tool consumer has a
   * predictable shape.
   */
  searchArchival(query: string): Promise<string>;
  /** Post-session: promote facts written during this session if warranted. */
  onTaskComplete(sessionId: string): Promise<void>;
}

export interface MemoryAgentDeps {
  agentId: string;
  coreMemory: CoreMemory;
  factStore: FactStore;
  promoter: FactPromoter;
  embed: EmbeddingService;
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

  // Shared embed → vector-search pipeline used by both prepareBriefing
  // (full session-start bundle) and searchArchival (mid-session re-query).
  // Same recall floor + facts-per-briefing limit applies to both — the
  // agent should see the same retrieval shape whether the query is
  // session-start intent or a mid-session search_context call.
  const searchFacts = async (query: string): Promise<readonly MemoryFact[]> => {
    const queryVec = await deps.embed.embed(query);
    return deps.factStore.search({
      agent_id: deps.agentId,
      scope: ["ic", "team", "org"],
      embedding: queryVec,
      limit: factsPerBriefing,
      min_similarity: BRIEFING_RECALL_FLOOR,
    });
  };

  return {
    async prepareBriefing(intent: string): Promise<BriefingResult> {
      const [blocks, facts] = await Promise.all([
        deps.coreMemory.read(deps.agentId),
        searchFacts(intent),
      ]);
      return composeBriefing(blocks, facts);
    },

    async prepareCoreOnly(): Promise<BriefingResult> {
      const blocks = await deps.coreMemory.read(deps.agentId);
      return composeBriefing(blocks, []);
    },

    async searchArchival(query: string): Promise<string> {
      return renderArchivalEnvelope(await searchFacts(query));
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
    // Description attribute is first-person guidance the agent reads
    // to decide WHAT belongs in this block. Surfaced alongside content
    // so the agent sees scope right next to the data it's about to
    // (potentially) edit. See packages/core/src/domain/core-memory.ts.
    const descAttr = b.description
      ? ` description="${escapeAttr(b.description)}"`
      : "";
    blockLines.push(
      `  <block name="${escapeAttr(b.block_name)}"${descAttr}>${escapeText(b.content)}</block>`,
    );
    blockSnapshots.push({
      name: b.block_name,
      chars: b.content.length,
      preview: b.content.slice(0, PREVIEW_CHARS),
    });
    charTotal += b.content.length;
  }

  const factSnapshots: SessionBriefingSnapshot["facts"] = [];
  for (const f of facts) {
    factSnapshots.push({
      scope: f.scope,
      content: f.content,
      // FactStore doesn't currently round-trip similarity score on the
      // returned MemoryFact. Backfill 0 until plumbed end-to-end.
      score: 0,
    });
    charTotal += f.content.length;
  }

  // M9.4: split along stability axis. core_memory (mostly stable per
  // agent) → system prompt; archival_memory (per-session vector hits) →
  // user message prefix.
  const systemLines = ["<core_memory>"];
  if (blockLines.length > 0) systemLines.push(...blockLines);
  systemLines.push("</core_memory>");

  // For prepareBriefing the archival half is empty when there are no
  // facts (don't pollute the user message with an empty wrapper).
  // searchArchival has the opposite contract — there it always emits
  // the wrapper for shape predictability.
  const userMessagePrefix = facts.length === 0 ? "" : renderArchivalEnvelope(facts);

  return {
    systemPromptAppend: systemLines.join("\n"),
    userMessagePrefix,
    snapshot: {
      block_count: blocks.length,
      fact_count: facts.length,
      token_count: Math.ceil(charTotal / 4),
      blocks: blockSnapshots,
      facts: factSnapshots,
    },
  };
}

/**
 * Format a single archival fact line with the date stamp from the row's
 * `created_at`. Surfacing the date lets the agent judge staleness when
 * reading retrieval results — a fact saved months ago may no longer hold
 * and should be verified against current state before acting.
 */
function renderFact(f: MemoryFact): string {
  const saved = f.created_at.toISOString().slice(0, 10);
  return `  <fact type="${escapeAttr(f.fact_type)}" scope="${f.scope}" saved="${saved}">${escapeText(f.content)}</fact>`;
}

/**
 * Wrap fact lines in the `<archival_memory>...</archival_memory>` envelope.
 * Always emits the envelope (empty body when no facts) so callers like
 * `searchArchival` get a predictable shape regardless of hit count.
 */
function renderArchivalEnvelope(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) return "<archival_memory></archival_memory>";
  const lines = ["<archival_memory>"];
  for (const f of facts) lines.push(renderFact(f));
  lines.push("</archival_memory>");
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
