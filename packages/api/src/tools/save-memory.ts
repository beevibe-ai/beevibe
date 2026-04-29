import type { FactStore } from "@beevibe/core/services/memory";
import { FACT_TYPES, type FactType } from "@beevibe/core";
import type { AgentTool } from "./types.js";

const SAVE_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description:
        "The fact, learning, or insight to save. One self-contained sentence; " +
        "future sessions retrieve this via vector search on its embedding.",
    },
    fact_type: {
      type: "string",
      enum: FACT_TYPES,
      description:
        "What kind of fact: belief (a position you hold), pattern (a recurring " +
        "observation), gotcha (a thing-that-bites if forgotten), preference " +
        "(your or the team's stated preference), decision (a chosen path with rationale).",
    },
  },
  required: ["content", "fact_type"],
} as const;

export interface SaveMemoryServices {
  factStore: FactStore;
}

export interface SaveMemoryContext {
  /** Agent the fact is being saved for. */
  agentId: string;
  /** Beevibe session id for `source_session_ids` provenance. */
  sessionId: string;
}

/**
 * Build the `save_memory` MCP tool, closed over a session's caller + sid.
 * Delegates to M3's `FactStore.addOrMerge` which handles dedup vs near-
 * duplicates via vector search.
 */
export function createSaveMemoryTool(
  ctx: SaveMemoryContext,
  services: SaveMemoryServices,
): AgentTool {
  return {
    name: "save_memory",
    description:
      "Save a fact, learning, or insight to your archival memory. Persists " +
      "across sessions; retrievable via the briefing's vector recall and via " +
      "search_context. Use one sentence per call — for multiple facts, call " +
      "the tool multiple times.",
    schema: SAVE_MEMORY_SCHEMA as Record<string, unknown>,
    handler: async (input) => {
      const content = input.content;
      const factType = input.fact_type;
      if (typeof content !== "string" || !content.trim()) {
        return {
          content: { error: "invalid_content", message: "content must be a non-empty string" },
          isError: true,
        };
      }
      if (typeof factType !== "string" || !FACT_TYPES.includes(factType as FactType)) {
        return {
          content: {
            error: "invalid_fact_type",
            message: `fact_type must be one of: ${FACT_TYPES.join(", ")}`,
          },
          isError: true,
        };
      }
      const fact = await services.factStore.addOrMerge(
        ctx.agentId,
        ctx.sessionId,
        content,
        factType as FactType,
      );
      return {
        content: { saved: true, fact_id: fact.id, fact_type: factType },
      };
    },
  };
}
