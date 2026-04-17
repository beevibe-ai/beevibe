export type MemoryScope = "ic" | "team" | "org";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["ic", "team", "org"] as const;

export type FactType = "belief" | "pattern" | "gotcha" | "preference" | "decision";

export const FACT_TYPES: readonly FactType[] = [
  "belief",
  "pattern",
  "gotcha",
  "preference",
  "decision",
] as const;

export type FactOperation = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface MemoryFact {
  id: string;
  agent_id: string;
  scope: MemoryScope;
  fact_type: FactType;
  content: string;
  embedding: number[];
  source_chain_ids: string[];
  confidence: number;
  valid_from: Date;
  tags: string[];
  metadata?: Record<string, unknown>;
  created_at: Date;
}

/**
 * Proposal from FactExtractor (LLM) about what to do with a fact.
 * Consumed by MemoryAgent service (M3) which applies the operation
 * against the MemoryFactRepository.
 */
export interface FactCandidate {
  content: string;
  fact_type: FactType;
  operation: FactOperation;
  existing_fact_id?: string;
  tags: string[];
  reason: string;
}
