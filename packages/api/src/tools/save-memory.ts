import type { FactStore } from "@beevibe/core/services/memory";
import {
  FACT_TYPES,
  FACT_TYPE_DESCRIPTIONS,
  hierarchyToScope,
  type FactType,
  type HierarchyLevel,
} from "@beevibe/core";
import type { AgentTool } from "./types.js";

/**
 * Render the per-fact-type guidance for the tool's `fact_type` enum
 * description. Reads from FACT_TYPE_DESCRIPTIONS so this stays in
 * lockstep with the same guidance the agent sees in its briefing —
 * mirrors `buildBlockNameDescription` in update-core-memory.ts.
 */
function buildFactTypeDescription(): string {
  const typeList = FACT_TYPES.map(
    (t) => `- **${t}**: ${FACT_TYPE_DESCRIPTIONS[t]}`,
  ).join("\n");
  return (
    "What kind of fact this is. Each type has a narrow purpose — content for " +
    "one type doesn't belong under another. Read the type guidance before " +
    "writing; if no type fits cleanly, you probably shouldn't save the fact.\n\n" +
    typeList
  );
}

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
      description: buildFactTypeDescription(),
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
  /** Saver's tier — converted to the fact's scope via `hierarchyToScope`. */
  hierarchyLevel: HierarchyLevel;
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
      "Save a fact, learning, or insight to long-term archival memory for " +
      "retrieval across all future sessions. Store self-contained facts that " +
      "stand alone when retrieved later (no \"we\", \"the user\", \"recently\" " +
      "— name specific entities and use definite language). One sentence per " +
      "call; for multiple facts, call the tool multiple times. The save date " +
      "is auto-stamped — future retrievals show saved=YYYY-MM-DD so old facts " +
      "can be judged for staleness. Persists across sessions; retrievable via " +
      "the briefing's vector recall and via search_context.",
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
        hierarchyToScope(ctx.hierarchyLevel),
      );
      // Echo `scope` because the agent didn't supply it — it was derived
      // from the caller's tier. Surfaces the resulting visibility so the
      // agent knows whether a fact is IC-private or team-/org-visible.
      return {
        content: { saved: true, fact_id: fact.id, fact_type: factType, scope: fact.scope },
      };
    },
  };
}
