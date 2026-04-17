import type { MemoryFact, MemoryScope, FactType } from "../domain/memory.js";

export type NewMemoryFact = Omit<MemoryFact, "created_at">;

export type MemoryFactPatch = Partial<
  Omit<MemoryFact, "id" | "agent_id" | "created_at">
>;

export interface VectorSearchParams {
  agent_id: string;
  scope: MemoryScope | MemoryScope[];
  embedding: number[];
  limit?: number;
  min_similarity?: number;
  fact_types?: FactType[];
}

export interface MemoryFactRepository {
  findById(id: string): Promise<MemoryFact | undefined>;

  findByIds(ids: string[]): Promise<MemoryFact[]>;

  create(input: NewMemoryFact): Promise<MemoryFact>;

  update(id: string, patch: MemoryFactPatch): Promise<MemoryFact>;

  delete(id: string): Promise<void>;

  /**
   * Cosine-similarity search over the HNSW index on memory_fact.embedding.
   * Returns facts in descending similarity order, capped at `limit`.
   * Results may be further filtered by scope + fact_types.
   */
  searchByVector(params: VectorSearchParams): Promise<MemoryFact[]>;

  /** Non-vector structured query: by agent + scope, for enumeration/consolidation. */
  listByAgentScope(agentId: string, scope: MemoryScope, limit?: number): Promise<MemoryFact[]>;

  /**
   * Reduce confidence by `decay_rate_per_day` × age (in days) for facts older than
   * `max_age_days`. Return count of facts updated. Facts below `min_confidence`
   * are not further decayed. M3 MemoryAgent calls this as part of consolidation.
   */
  decay(
    agentId: string,
    max_age_days: number,
    decay_rate_per_day: number,
    min_confidence: number,
  ): Promise<number>;
}
