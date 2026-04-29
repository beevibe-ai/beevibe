import type { CoreMemory, CoreMemoryOperation } from "@beevibe/core/services/memory";
import type { AgentTool } from "./types.js";

const OPERATIONS: readonly CoreMemoryOperation[] = ["append", "replace"];

const UPDATE_CORE_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    block_name: {
      type: "string",
      description:
        "Which core-memory block to edit. ICs typically have: persona, " +
        "domain, constraints, learnings.",
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

export interface UpdateCoreMemoryServices {
  coreMemory: CoreMemory;
}

export interface UpdateCoreMemoryContext {
  agentId: string;
}

/**
 * Build the `update_core_memory` MCP tool. Delegates to M3's
 * `CoreMemory.applyUpdate` which validates block existence + operation
 * shape (e.g. replace requires old_content match).
 */
export function createUpdateCoreMemoryTool(
  ctx: UpdateCoreMemoryContext,
  services: UpdateCoreMemoryServices,
): AgentTool {
  return {
    name: "update_core_memory",
    description:
      "Edit one of your core-memory blocks (persona/domain/constraints/" +
      "learnings/etc). These appear in every future session's briefing. " +
      "Use append to add a paragraph, replace to substitute a specific " +
      "passage. Prefer focused, durable edits over chatter.",
    schema: UPDATE_CORE_MEMORY_SCHEMA as Record<string, unknown>,
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
