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

  /** Non-vector structured query: by agent + scope, for enumeration. */
  listByAgentScope(agentId: string, scope: MemoryScope, limit?: number): Promise<MemoryFact[]>;

  /**
   * Fetch every fact whose `source_session_ids` contains the given session id.
   * Used by MemoryAgent.onTaskComplete to enumerate facts touched during a
   * session for promotion evaluation. SQL: `WHERE $1 = ANY(source_session_ids)`.
   */
  listBySessionId(sessionId: string): Promise<MemoryFact[]>;
}
