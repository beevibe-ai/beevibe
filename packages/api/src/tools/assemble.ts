import type { ResolvedCaller } from "@beevibe/core/auth";
import type { CoreMemory, FactStore } from "@beevibe/core/services/memory";
import { createSaveMemoryTool } from "./save-memory.js";
import { createUpdateCoreMemoryTool } from "./update-core-memory.js";
import type { AgentTool } from "./types.js";

export interface AssembleToolsServices {
  factStore: FactStore;
  coreMemory: CoreMemory;
}

export interface AssembleToolsContext {
  caller: ResolvedCaller;
  /**
   * The beevibe session id this MCP session is bound to. For agents:
   * extracted from `X-Beevibe-Session` header at session-init time.
   * For humans: minted when the chat session row is created at initialize.
   */
  beevibeSid: string;
}

/**
 * Build the per-session tool set for a resolved caller. Each tool is a fresh
 * closure over `(ctx, services)` so handlers see the right caller + sid
 * without async-storage threading.
 *
 * M6.2 ships memory tools (save_memory, update_core_memory). Subsequent
 * milestones extend this with hierarchy tools (M6.3), work-product tools
 * (M6.3), mesh tools + escalation (M6.4), and revise_task (M6.4).
 */
export function assembleTools(
  ctx: AssembleToolsContext,
  services: AssembleToolsServices,
): AgentTool[] {
  return [
    createSaveMemoryTool(
      { agentId: ctx.caller.agentId, sessionId: ctx.beevibeSid },
      { factStore: services.factStore },
    ),
    createUpdateCoreMemoryTool(
      { agentId: ctx.caller.agentId },
      { coreMemory: services.coreMemory },
    ),
  ];
}
