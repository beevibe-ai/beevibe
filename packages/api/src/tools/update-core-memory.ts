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
          "append: concatenate content as a new line at the end of the " +
          "block. ONLY for accumulating-list blocks (e.g. team_members); " +
          "never for narrative blocks — see the tool description's " +
          "decision criterion. replace: substitute old_content with " +
          "content (old_content required). Use replace for surgical " +
          "fixes AND for consolidating rewrites of narrative blocks " +
          "(pass the whole current block as old_content).",
      },
      content: {
        type: "string",
        description:
          "The new content. For append: appended verbatim with a leading " +
          "newline. For replace: the substring (or whole-block contents) " +
          "that takes the place of old_content.",
      },
      old_content: {
        type: "string",
        description:
          "Required for replace. The exact substring to substitute — " +
          "must match verbatim somewhere in the existing block. For a " +
          "consolidating rewrite of a narrative block, pass the FULL " +
          "current block contents (verbatim from <core_memory>).",
      },
    },
    required: ["block_name", "operation", "content"],
  } as const;

  return {
    name: "update_core_memory",
    description:
      "Edit one of your core-memory blocks. These blocks ride in every " +
      "future session's system prompt — treat as expensive real estate. " +
      "The block's current contents are already visible in your " +
      "<core_memory> render; read them there before composing the edit. " +
      "This tool does not return current contents.\n\n" +
      "## Choosing between `append` and `replace`\n\n" +
      "Use `append` ONLY when the block is an accumulating list — every " +
      "line is a discrete, self-contained item that gets added over time " +
      "(e.g. `team_members` where each line is one teammate, `teams` for " +
      "an org agent's roster). Append concatenates with a newline; it " +
      "does not merge, deduplicate, or consolidate.\n\n" +
      "Use `replace` for everything else:\n" +
      "  - Surgical fix: substitute one substring with another.\n" +
      "  - Folding new information into a narrative block (persona, " +
      "domain, active_context, active_work, patterns, constraints, " +
      "strategy, tag_line). Read the current contents from " +
      "<core_memory>, mentally merge the new info into a consolidated " +
      "version, then call replace with the FULL OLD contents as " +
      "`old_content` and the FULL NEW contents as `content`. Without a " +
      "separate consolidation tool, this whole-block replace is how you " +
      "rewrite a narrative block.\n" +
      "  - Removing content: replace with empty string.\n\n" +
      "## Hard rule: never append to narrative blocks\n\n" +
      "Narrative blocks summarize CURRENT STATE — they are not " +
      "changelogs. Appending to them causes bloat that lands in every " +
      "future session's system prompt. If you have new info for a " +
      "narrative block, do a consolidating replace, not an append.\n\n" +
      "NEVER prepend or append `UPDATE YYYY-MM-DD:` entries to any " +
      "block. The block is current state, not a log. Dated facts belong " +
      "in archival memory via `save_memory`, which auto-stamps the date.\n\n" +
      "If unsure between core and archival, prefer `save_memory` " +
      "(archival is cheap and forgiving). Promote to core only when a " +
      "fact has already surfaced across multiple sessions AND belongs " +
      "in every future briefing.\n\n" +
      "## Examples\n\n" +
      "GOOD — surgical fix (one substring → another):\n" +
      "  update_core_memory(\n" +
      "    block_name=\"domain\",\n" +
      "    operation=\"replace\",\n" +
      "    old_content=\"Postgres\",\n" +
      "    content=\"Postgres + pgvector\"\n" +
      "  )\n\n" +
      "GOOD — new item on an accumulating-list block:\n" +
      "  update_core_memory(\n" +
      "    block_name=\"team_members\",\n" +
      "    operation=\"append\",\n" +
      "    content=\"- Frontend Platform (agent_Y) — Next.js + Tailwind\"\n" +
      "  )\n\n" +
      "GOOD — consolidating rewrite of a narrative block (use replace, not append):\n" +
      "  update_core_memory(\n" +
      "    block_name=\"active_context\",\n" +
      "    operation=\"replace\",\n" +
      "    old_content=\"<entire current contents of active_context, verbatim>\",\n" +
      "    content=\"<new consolidated contents reflecting prior state + new info>\"\n" +
      "  )\n\n" +
      "BAD — appending a dated update to a narrative block:\n" +
      "  update_core_memory(\n" +
      "    block_name=\"active_work\",\n" +
      "    operation=\"append\",\n" +
      "    content=\"UPDATE 2026-05-25: Audit complete. Dispatching 11 fix tasks...\"\n" +
      "  )\n" +
      "  # Wrong: bloats the block and turns it into a changelog that\n" +
      "  # every future session inherits. Use replace with a consolidated\n" +
      "  # rewrite, or save the dated note via save_memory.\n\n" +
      "BAD — using append to revise an existing fact:\n" +
      "  update_core_memory(\n" +
      "    block_name=\"team_members\",\n" +
      "    operation=\"append\",\n" +
      "    content=\"- Backend Platform now also handles Redis\"\n" +
      "  )\n" +
      "  # Wrong: now the block has two contradictory lines about\n" +
      "  # Backend Platform. Use replace to update the existing bullet\n" +
      "  # in place.",
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
