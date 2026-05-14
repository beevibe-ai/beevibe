import type { HierarchyLevel } from "./agent.js";

export type MemoryScope = "ic" | "team" | "org";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["ic", "team", "org"] as const;

/**
 * Identity converter from HierarchyLevel → MemoryScope. The two unions
 * share the same string values today (`"ic" | "team" | "org"`) but are
 * intentionally distinct nominal types: HierarchyLevel describes an
 * agent's tier; MemoryScope describes a fact's visibility. Using this
 * helper instead of a raw `as MemoryScope` cast documents the
 * equivalence in code and gives us one place to revisit if the two
 * sets ever diverge (e.g., a future "domain" memory scope below ic).
 */
export function hierarchyToScope(level: HierarchyLevel): MemoryScope {
  return level;
}

export type FactType = "belief" | "pattern" | "gotcha" | "preference" | "decision";

export const FACT_TYPES: readonly FactType[] = [
  "belief",
  "pattern",
  "gotcha",
  "preference",
  "decision",
] as const;

/**
 * Per-fact-type guidance. Single source of truth — surfaced inside the
 * `save_memory` tool's `fact_type` enum description so the agent sees
 * the intent + the "don't save this" guards at decision time, before
 * it writes. Mirrors the role of `BlockTemplate.description` for core
 * memory.
 *
 * The failure-mode guards encoded here come from issue #90: agents
 * over-saved (a) one-off scoped requests as durable preferences and
 * (b) self-referential meta-patterns about their own search/save
 * behavior. Each description names the trap explicitly.
 */
export const FACT_TYPE_DESCRIPTIONS: Record<FactType, string> = {
  belief:
    "A position you hold based on multiple sessions of evidence. A lasting view, " +
    "not a fleeting reaction to one session.",
  pattern:
    "A recurring observation about the codebase or the domain you work in — " +
    "knowledge another agent could reuse. NOT a pattern about your own behavior " +
    "(your search habits, your memory-keeping, how you should have responded next " +
    "time). Save the thing you learned about the world, not a note-to-self about " +
    "how to behave.",
  gotcha:
    "A non-obvious thing-that-bites — a footgun that's easy to step on, where the " +
    "surprise itself is the value. Concrete and reusable across future tasks in " +
    "the same area.",
  preference:
    "A user's stated durable rule. Trigger words: \"always\", \"from now on\", " +
    "\"every time\", \"as a default\", \"going forward\". Do NOT save preferences " +
    "for one-off requests scoped to a specific task, session, or work-product " +
    "(\"after this task\", \"for this audit\", \"now\"). When in doubt, just do the " +
    "thing once without saving — the user can restate it if they want it to stick.",
  decision:
    "A chosen path with rationale. The \"why\" that future-you (or another agent) " +
    "needs to understand why the codebase / approach looks the way it does — not " +
    "the mechanical \"what\" (read the code for that).",
};

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
