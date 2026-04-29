import type { ResolvedCaller } from "@beevibe/core/auth";
import type {
  AgentRepository,
  TaskRepository,
  WorkProductRepository,
} from "@beevibe/core";
import type { CoreMemory, FactStore, MemoryAgent } from "@beevibe/core/services/memory";
import type { TaskService } from "@beevibe/core/services/task-service";
import { buildHierarchyTools } from "./hierarchy.js";
import { createSaveMemoryTool } from "./save-memory.js";
import { createUpdateCoreMemoryTool } from "./update-core-memory.js";
import type { AgentTool } from "./types.js";

export interface AssembleToolsServices {
  factStore: FactStore;
  coreMemory: CoreMemory;
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  workProductRepo: WorkProductRepository;
  taskService: TaskService;
  /**
   * Per-caller MemoryAgent — used by `search_context` for in-session vector
   * recall. Each session passes the MemoryAgent it was built with so the
   * agentId is already baked in.
   */
  memoryAgent: MemoryAgent;
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
 * Build the full per-session tool set for a resolved caller. Each tool is a
 * fresh closure over `(ctx, services)` so handlers see the right caller +
 * sid without async-storage threading.
 *
 * Composition (M6.3):
 *   - 2 memory tools: save_memory, update_core_memory
 *   - 8 shared hierarchy tools (IC + team): search_context, update_progress,
 *     find_up, get_agent_profile, get_task, create_work_product,
 *     list_work_products, update_work_product
 *   - 4 team-only tools: find_subordinates, find_peers, create_task,
 *     check_work_status
 *
 * IC agents get 10 tools total (2 memory + 8 shared hierarchy).
 * Team / org agents get 14 (2 memory + 12 hierarchy/work-product).
 *
 * M6.4 adds 6 mesh tools + add_to_escalation + revise_task to the team set.
 */
export function assembleTools(
  ctx: AssembleToolsContext,
  services: AssembleToolsServices,
): AgentTool[] {
  const memoryTools: AgentTool[] = [
    createSaveMemoryTool(
      { agentId: ctx.caller.agentId, sessionId: ctx.beevibeSid },
      { factStore: services.factStore },
    ),
    createUpdateCoreMemoryTool(
      { agentId: ctx.caller.agentId },
      { coreMemory: services.coreMemory },
    ),
  ];

  const hierarchyTools = buildHierarchyTools(
    {
      agentId: ctx.caller.agentId,
      hierarchyLevel: ctx.caller.hierarchyLevel,
    },
    {
      agentRepo: services.agentRepo,
      taskRepo: services.taskRepo,
      workProductRepo: services.workProductRepo,
      taskService: services.taskService,
      memoryAgent: services.memoryAgent,
    },
  );

  return [...memoryTools, ...hierarchyTools];
}
