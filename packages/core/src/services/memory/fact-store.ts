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
  embed: EmbeddingService;
  llm: LlmProvider;
}

export class FactStore {
  constructor(private deps: FactStoreDeps) {}

  /**
   * Embed the new content; if its nearest neighbor (same fact_type, same
   * agent, same scope) is above SIMILARITY_MERGE_THRESHOLD, LLM-merge the
   * two and update the existing row with the merged content, re-embed, and
   * the union of source_session_ids. Otherwise insert a new fact.
   *
   * `scope` reflects the saving agent's tier: an IC agent's facts start at
   * `ic`, a team agent's at `team`, an org agent's at `org`. Promotion
   * UPWARD (e.g. `team` → `org`) still happens post-session via
   * FactPromoter when a fact recurs across enough sessions.
   *
   * Dedup-merge is scoped: a team agent saving something near-identical to
   * an existing `ic` fact creates a fresh `team` row rather than merging
   * across scopes — the two facts live in different conceptual universes
   * (one is IC-private, the other is team-wide knowledge).
   */
  async addOrMerge(
    agentId: string,
    sessionId: string,
    content: string,
    fact_type: FactType,
    scope: MemoryScope,
  ): Promise<MemoryFact> {
    const embedding = await this.deps.embed.embed(content);
    const [neighbor] = await this.deps.repo.searchByVector({
      agent_id: agentId,
      scope,
      embedding,
      limit: 1,
      min_similarity: SIMILARITY_MERGE_THRESHOLD,
      fact_types: [fact_type],
    });

    if (!neighbor) {
      return this.deps.repo.create({
        id: factId(),
        agent_id: agentId,
        scope,
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

    const mergedEmbedding = await this.deps.embed.embed(mergedText);
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
