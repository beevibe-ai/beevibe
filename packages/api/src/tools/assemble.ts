import type { ResolvedCaller } from "@beevibe/core/auth";
import type {
  AgentRepository,
  CoreMemoryBlockRepository,
  TaskRepository,
  WorkProductRepository,
} from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { CoreMemory, FactStore, MemoryAgent } from "@beevibe/core/services/memory";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { MeshServer } from "../mesh/server.js";
import { buildIcMeshTools, buildTeamMeshTools } from "./mesh.js";
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
  escalationService: EscalationService;
  dispatchService: DispatchService;
  mesh: MeshServer;
  pool: Pool;
  memoryAgent: MemoryAgent;
  /** Phase 9: backs `create_subordinate_agent` (seeds persona/domain blocks). */
  coreMemoryRepo: CoreMemoryBlockRepository;
}

/**
 * /mcp callers are bv_a_ (agent) or bv_u_ (human). Daemons authenticate to
 * /runtime/* only and are rejected at the /mcp entry point.
 */
export type McpCaller = Exclude<ResolvedCaller, { source: "daemon" }>;

export interface AssembleToolsContext {
  caller: McpCaller;
  beevibeSid: string;
}

/**
 * Build the full per-session tool set for a resolved caller. Each tool is a
 * fresh closure over `(ctx, services)` so handlers see the right caller +
 * sid without async-storage threading.
 *
 * Tier breakdown (M9.1 final):
 *
 *   IC (12 tools):
 *     2 memory: save_memory, update_core_memory
 *     8 hierarchy (shared): search_context, update_progress, find_up,
 *       get_agent_profile, get_task, create_work_product,
 *       list_work_products, update_work_product
 *     2 mesh: respond_ask (when targeted by team-tier `ask`),
 *             report_blocker (escalate up to direct parent)
 *
 *   Team / org (23 tools):
 *     2 memory + 14 hierarchy (8 shared + 6 team-only) +
 *     6 mesh (ask, respond_ask, negotiate, respond_negotiate,
 *             report_blocker, escalate_to_humans).
 *
 * Team-only hierarchy adds: find_subordinates, find_peers, create_task,
 *   check_work_status, revise_task, add_to_escalation.
 *
 * M9.1: dropped `respond_negotiate` from IC tier; ICs are workers, not
 * deciders. Server-side `MeshServer.sendNegotiate` rejects IC targets with
 * CannotNegotiateWithIcError to enforce this structurally.
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
      escalationService: services.escalationService,
      dispatchService: services.dispatchService,
      pool: services.pool,
      coreMemoryRepo: services.coreMemoryRepo,
    },
  );

  const meshCtx = { caller: ctx.caller, beevibeSid: ctx.beevibeSid };
  const meshServices = {
    mesh: services.mesh,
    agentRepo: services.agentRepo,
    taskRepo: services.taskRepo,
    taskService: services.taskService,
    escalationService: services.escalationService,
    pool: services.pool,
  };
  const meshTools =
    ctx.caller.hierarchyLevel === "ic"
      ? buildIcMeshTools(meshCtx, meshServices)
      : buildTeamMeshTools(meshCtx, meshServices);

  return [...memoryTools, ...hierarchyTools, ...meshTools];
}
