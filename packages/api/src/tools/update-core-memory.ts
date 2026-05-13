import type { CoreMemory, CoreMemoryOperation } from "@beevibe/core/services/memory";
import type { HierarchyLevel } from "@beevibe/core";
import { DEFAULT_BLOCK_TEMPLATES } from "@beevibe/core";
import type { AgentTool } from "./types.js";

const OPERATIONS: readonly CoreMemoryOperation[] = ["append", "replace"];

/**
 * Compose per-block guidance for the agent's `block_name` enum. Reads
 * straight from DEFAULT_BLOCK_TEMPLATES so this stays in lockstep with
 * the same descriptions the agent sees on its <core_memory> render and
 * via create_subordinate_agent's field descriptions — single source of
 * truth for block semantics.
 */
function buildBlockNameDescription(level: HierarchyLevel): string {
  const templates = DEFAULT_BLOCK_TEMPLATES[level];
  const blockList = templates
    .map((t) => `- **${t.block_name}**: ${t.description}`)
    .join("\n");
  return (
    "Which core-memory block to edit. Each block has a narrow purpose — " +
    "content for one block doesn't belong in another. Read the block's " +
    "`description` attribute in your <core_memory> render before writing.\n\n" +
    "Available blocks at your tier:\n" +
    blockList
  );
}

export interface UpdateCoreMemoryServices {
  coreMemory: CoreMemory;
}

export interface UpdateCoreMemoryContext {
  agentId: string;
  hierarchyLevel: HierarchyLevel;
}

/**
 * Build the `update_core_memory` MCP tool. Delegates to M3's
 * `CoreMemory.applyUpdate` which validates block existence + operation
 * shape (e.g. replace requires old_content match).
 *
 * The `block_name` enum is tier-aware: an IC agent sees ic blocks
 * (persona/domain/active_context/constraints/tag_line), team agents see
 * team blocks (persona/team_members/active_work/patterns/tag_line),
 * etc. — prevents writes to non-existent blocks at the protocol level.
 */
export function createUpdateCoreMemoryTool(
  ctx: UpdateCoreMemoryContext,
  services: UpdateCoreMemoryServices,
): AgentTool {
  const tierBlocks = DEFAULT_BLOCK_TEMPLATES[ctx.hierarchyLevel].map(
    (t) => t.block_name,
  );

  const schema = {
    type: "object",
    properties: {
      block_name: {
        type: "string",
        enum: tierBlocks,
        description: buildBlockNameDescription(ctx.hierarchyLevel),
      },
      operation: {
        type: "string",
        enum: OPERATIONS,
        description:
          "append: add new content at the end of the existing block. " +
          "replace: substitute old_content with content (old_content required).",
      },
      content: {
        type: "string",
        description:
          "The new content. For append: appended verbatim. For replace: replaces old_content.",
      },
      old_content: {
        type: "string",
        description:
          "Required for replace. The exact substring to substitute. Must match " +
          "exactly (verbatim) somewhere in the existing block.",
      },
    },
    required: ["block_name", "operation", "content"],
  } as const;

  return {
    name: "update_core_memory",
    description:
      "Edit one of your core-memory blocks. These appear in every future " +
      "session's briefing — treat as expensive real estate. Use ONLY for " +
      "stable, durable shifts that should appear in every future briefing: " +
      "persona changes, long-term constraint changes, patterns confirmed " +
      "across multiple sessions. NOT for one-shot facts (use save_memory " +
      "instead). If unsure between core and archival, use save_memory; " +
      "promote to core later if the fact recurs across sessions. Use " +
      "append to add a paragraph, replace to substitute a specific passage.",
    schema: schema as Record<string, unknown>,
    handler: async (input) => {
      const blockName = input.block_name;
      const operation = input.operation;
      const content = input.content;
      const oldContent = input.old_content;

      if (typeof blockName !== "string" || !blockName.trim()) {
        return {
          content: { error: "invalid_block_name", message: "block_name must be a non-empty string" },
          isError: true,
        };
      }
      if (!tierBlocks.includes(blockName)) {
        return {
          content: {
            error: "unknown_block",
            message: `block_name must be one of: ${tierBlocks.join(", ")}`,
          },
          isError: true,
        };
      }
      if (typeof operation !== "string" || !OPERATIONS.includes(operation as CoreMemoryOperation)) {
        return {
          content: {
            error: "invalid_operation",
            message: `operation must be one of: ${OPERATIONS.join(", ")}`,
          },
          isError: true,
        };
      }
      if (typeof content !== "string") {
        return {
          content: { error: "invalid_content", message: "content must be a string" },
          isError: true,
        };
      }
      if (operation === "replace" && (typeof oldContent !== "string" || !oldContent)) {
        return {
          content: {
            error: "missing_old_content",
            message: "operation='replace' requires old_content",
          },
          isError: true,
        };
      }

      try {
        const block = await services.coreMemory.applyUpdate(
          ctx.agentId,
          blockName,
          operation as CoreMemoryOperation,
          content,
          oldContent as string | undefined,
        );
        return {
          content: {
            updated: true,
            block_name: block.block_name,
            content_length: block.content.length,
          },
        };
      } catch (err) {
        return {
          content: {
            error: "update_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          isError: true,
        };
      }
    },
  };
}
