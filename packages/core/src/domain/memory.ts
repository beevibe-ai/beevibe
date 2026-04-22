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
