import type { AgentRepository, HierarchyLevel } from "@beevibe/core";
import { DEFAULT_BLOCK_TEMPLATES } from "@beevibe/core";
import type { AlignmentService } from "@beevibe/core/services/alignment";
import type { AlignmentTargetRef } from "@beevibe/core";
import type { AgentTool } from "./types.js";

const IC_BLOCKS = DEFAULT_BLOCK_TEMPLATES.ic.map((t) => t.block_name);
const OPERATIONS = ["append", "replace"] as const;

export interface CorrectSubordinateMemoryContext {
  /** The calling team/org agent. */
  agentId: string;
  hierarchyLevel: HierarchyLevel;
  /** The live chat (meeting) session — ties the correction to a meeting. */
  sessionId: string;
}

export interface CorrectSubordinateMemoryServices {
  agentRepo: AgentRepository;
  alignmentService: AlignmentService;
}

/**
 * Team/org-only tool. Lets a team agent fix a specialist's core memory during
 * an alignment meeting — the cross-agent write-back path that `update_core_memory`
 * (own-memory only) can't do. Authz mirrors `create_task`: the target must be a
 * direct subordinate. When the session is tied to a meeting, the fix is recorded
 * as an applied action item for the meeting's audit trail.
 */
export function createCorrectSubordinateMemoryTool(
  ctx: CorrectSubordinateMemoryContext,
  services: CorrectSubordinateMemoryServices,
): AgentTool {
  return {
    name: "correct_subordinate_memory",
    description:
      "Fix a drifted belief or rule in one of your specialists' core memory. " +
      "Use this in an alignment meeting once the human has confirmed a " +
      "correction. It edits the SUBORDINATE's own core-memory block " +
      "(persona / domain / constraints / active_context / tag_line) and takes " +
      "effect in that specialist's next session. This is the only way to " +
      "write another agent's memory — update_core_memory edits your own.\n\n" +
      "Prefer `replace`: pass the exact current text as old_content and the " +
      "corrected text as content. Keep the correction tight — these blocks " +
      "ride in every future session. Set `title` to a plain-language headline " +
      "of the fix (e.g. \"Memory is self-contained per specialist, not shared\").",
    schema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The specialist to correct — must be a direct subordinate.",
        },
        block_name: {
          type: "string",
          enum: IC_BLOCKS,
          description: "Which of the specialist's core-memory blocks to edit.",
        },
        operation: {
          type: "string",
          enum: [...OPERATIONS],
          description:
            "replace: swap old_content for content (preferred for fixing a " +
            "drifted belief). append: add a new line (only for list-style blocks).",
        },
        content: {
          type: "string",
          description: "The corrected text.",
        },
        old_content: {
          type: "string",
          description:
            "Required for replace — the exact existing text to swap out.",
        },
        title: {
          type: "string",
          description: "Plain-language headline of the correction.",
        },
        rationale: {
          type: "string",
          description: "Optional: why this is the right fix (for the meeting record).",
        },
      },
      required: ["agent_id", "block_name", "operation", "content", "title"],
    },
    handler: async (input) => {
      try {
        const targetId = String(input.agent_id ?? "");
        const blockName = String(input.block_name ?? "");
        const operation = String(input.operation ?? "");
        const content = String(input.content ?? "");
        const title = String(input.title ?? "");
        const oldContent =
          typeof input.old_content === "string" ? input.old_content : undefined;
        const rationale =
          typeof input.rationale === "string" ? input.rationale : undefined;

        if (!targetId || !blockName || !title) {
          return {
            content: { error: "agent_id, block_name, and title are required" },
            isError: true,
          };
        }
        if (!IC_BLOCKS.includes(blockName)) {
          return {
            content: {
              error: "unknown_block",
              message: `block_name must be one of: ${IC_BLOCKS.join(", ")}`,
            },
            isError: true,
          };
        }
        if (operation !== "append" && operation !== "replace") {
          return {
            content: { error: "operation must be 'append' or 'replace'" },
            isError: true,
          };
        }
        if (operation === "replace" && !oldContent) {
          return {
            content: { error: "operation='replace' requires old_content" },
            isError: true,
          };
        }

        // Authz: target must be a direct subordinate (mirrors create_task).
        const subs = await services.agentRepo.findSubordinates(ctx.agentId);
        if (!subs.some((s) => s.id === targetId)) {
          return {
            content: {
              error: "not_subordinate",
              message: `Cannot correct ${targetId} — not a direct subordinate of ${ctx.agentId}.`,
            },
            isError: true,
          };
        }

        const targetRef: AlignmentTargetRef = {
          type: "core_block",
          block_name: blockName,
          operation,
          content,
          ...(oldContent !== undefined ? { old_content: oldContent } : {}),
        };

        const result = await services.alignmentService.applyCorrectionForSession({
          chatSessionId: ctx.sessionId,
          agentId: targetId,
          targetRef,
          title,
          ...(rationale !== undefined ? { rationale } : {}),
        });

        return {
          content: {
            corrected: true,
            agent_id: targetId,
            block_name: blockName,
            action_item_id: result.action_item_id,
          },
        };
      } catch (err) {
        return {
          content: {
            error: "correction_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          isError: true,
        };
      }
    },
  };
}
