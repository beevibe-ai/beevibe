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

export interface MemoryFact {
  id: string;
  agent_id: string;
  scope: MemoryScope;
  fact_type: FactType;
  content: string;
  embedding: number[];
  /**
   * Every session that created, updated, or merged into this fact. Used by
   * MemoryAgent.onTaskComplete(sessionId) to find facts touched during a
   * session for promotion evaluation — the executor queries by session_id
   * because the MCP server (which does the writes) lives in a separate process.
   */
  source_session_ids: string[];
  created_at: Date;
}

/**
 * Audit row written by `MemoryAgent.onTaskComplete` for every FactPromoter
 * decision (promoted + rejected). Surfaces on the Promotions page so the
 * LLM's reasoning is auditable.
 *
 * `from_scope` is nullable for forward-compat with a future fact-creation
 * event source; FactPromoter always writes a non-null value.
 */
export interface MemoryPromotionEvent {
  id: string;
  fact_id: string;
  from_scope: MemoryScope | null;
  to_scope: MemoryScope;
  origin_agent_id: string;
  promoter_reason: string;
  source_session_ids: string[];
  rejected: boolean;
  created_at: Date;
}
