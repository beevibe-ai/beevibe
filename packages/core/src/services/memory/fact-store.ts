import type { FactType, MemoryFact, MemoryScope } from "../../domain/memory.js";
import { factId } from "../../domain/ids.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { LlmProvider } from "../../ports/llm-provider.js";
import type {
  MemoryFactRepository,
  VectorSearchParams,
} from "../../ports/memory-fact-repo.js";

/**
 * Cosine-similarity threshold above which two facts are considered the same
 * observation and merged. `text-embedding-3-small` with normalized cosine
 * scoring: 0.88 is empirically a safe "these are the same fact phrased
 * differently" floor.
 */
export const SIMILARITY_MERGE_THRESHOLD = 0.88;

const MERGE_SYSTEM_PROMPT =
  "You merge two observations into one coherent factual statement. Preserve every concrete specific from both. " +
  "Return ONLY the merged statement as a single sentence — no preamble, no bullet points, no quotes.";

const MERGE_MAX_TOKENS = 500;
const MERGE_TEMPERATURE = 0.2;

export interface FactStoreDeps {
  repo: MemoryFactRepository;
  /**
   * Embedding service for new fact content. Optional: when absent,
   * `addOrMerge` throws `MEMORY_DISABLED` and memory writes return a
   * graceful error to the caller (typically the `save_memory` MCP tool,
   * which surfaces it to the agent as "memory writes disabled — skip").
   * Vector search (`search`) still works against existing rows; the
   * caller controls whether to query.
   */
  embed?: EmbeddingService;
  /**
   * LLM used to merge near-duplicate observations into one coherent fact.
   * Optional: when absent, `addOrMerge` always inserts a new fact (no
   * dedup-merge), keeping memory functional in installs without an
   * Anthropic API key. Memory may grow with semantic-near-dupes; the
   * vector search still surfaces them by similarity at recall time.
   */
  llm?: LlmProvider;
}

/**
 * Sentinel error: thrown by `addOrMerge` when no embedding service is
 * configured. Callers (`save_memory` MCP tool) should match this and
 * return a friendly disabled-memory message to the agent rather than
 * propagating an opaque stack.
 */
export const MEMORY_DISABLED_ERROR =
  "MEMORY_DISABLED: no embedding service configured (OPENAI_API_KEY missing)";

export class FactStore {
  constructor(private deps: FactStoreDeps) {}

  /**
   * Embed the new content; if its nearest neighbor (same fact_type, same
   * agent, scope=ic) is above SIMILARITY_MERGE_THRESHOLD, LLM-merge the two
   * and update the existing row with the merged content, re-embed, and the
   * union of source_session_ids. Otherwise insert a new fact.
   *
   * Facts are always created at scope="ic"; promotion to team/org happens
   * post-session via FactPromoter.
   */
  async addOrMerge(
    agentId: string,
    sessionId: string,
    content: string,
    fact_type: FactType,
  ): Promise<MemoryFact> {
    const embed = this.deps.embed;
    if (!embed) {
      throw new Error(MEMORY_DISABLED_ERROR);
    }
    const embedding = await embed.embed(content);
    const [neighbor] = await this.deps.repo.searchByVector({
      agent_id: agentId,
      scope: "ic",
      embedding,
      limit: 1,
      min_similarity: SIMILARITY_MERGE_THRESHOLD,
      fact_types: [fact_type],
    });

    // No neighbor, OR neighbor exists but no LLM is available to merge —
    // either way, insert a new row. The "no LLM" branch is the graceful-
    // degraded mode for installs without an Anthropic API key: we accept
    // some semantic duplication in exchange for keeping memory writes
    // working at all.
    if (!neighbor || !this.deps.llm) {
      return this.deps.repo.create({
        id: factId(),
        agent_id: agentId,
        scope: "ic",
        fact_type,
        content,
        embedding,
        source_session_ids: [sessionId],
      });
    }

    const mergedText = (
      await this.deps.llm.complete({
        system: MERGE_SYSTEM_PROMPT,
        prompt: `Observation A: ${neighbor.content}\nObservation B: ${content}\nMerged:`,
        maxTokens: MERGE_MAX_TOKENS,
        temperature: MERGE_TEMPERATURE,
      })
    ).text.trim();

    const mergedEmbedding = await embed.embed(mergedText);
    const mergedSessionIds = Array.from(
      new Set([...neighbor.source_session_ids, sessionId]),
    );

    return this.deps.repo.update(neighbor.id, {
      content: mergedText,
      embedding: mergedEmbedding,
      source_session_ids: mergedSessionIds,
    });
  }

  /** Promote a fact to a wider scope. Called by FactPromoter post-session. */
  async updateScope(id: string, targetScope: MemoryScope): Promise<MemoryFact> {
    return this.deps.repo.update(id, { scope: targetScope });
  }

  /** Proxy for briefing-side vector search (MemoryAgent.prepareBriefing). */
  async search(params: VectorSearchParams): Promise<MemoryFact[]> {
    return this.deps.repo.searchByVector(params);
  }

  /** Proxy for post-session fact enumeration (MemoryAgent.onTaskComplete). */
  async listBySessionId(sessionId: string): Promise<MemoryFact[]> {
    return this.deps.repo.listBySessionId(sessionId);
  }
}
