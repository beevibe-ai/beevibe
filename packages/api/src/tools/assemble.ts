import type { ResolvedCaller } from "@beevibe/core/auth";
import type {
  AgentProvisionEventRepository,
  AgentRepository,
  CoreMemoryBlockRepository,
  SessionSpawnMode,
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
  /** Phase 9: audit log + per-parent daily cap on subordinate spawning. */
  agentProvisionEventRepo: AgentProvisionEventRepository;
}

/**
 * /mcp callers are bv_a_ (agent) or bv_u_ (human). Daemons authenticate to
 * /runtime/* only and are rejected at the /mcp entry point.
 */
export type McpCaller = Exclude<ResolvedCaller, { source: "daemon" }>;

export interface AssembleToolsContext {
  caller: McpCaller;
  beevibeSid: string;
  /**
   * Session spawn mode. When 'server_fallback_mesh', the caller is running
   * inside a server-spawned restricted-tool process (target's daemon was
   * offline at dispatch). The tool surface filter strips mutating ops
   * (`create_task`, `update_work_product`, `revise_task`, `add_to_escalation`,
   * `create_subordinate_agent`) so a mesh fallback caller can answer the ask
   * but can't carry on building work outside the conversation.
   */
  spawnMode?: SessionSpawnMode;
}

/**
 * Hierarchy tools that are read-only or scoped to the conversation itself
 * (search_context, update_progress on the in-flight session, get_*). These
 * are safe to expose under server_fallback_mesh.
 */
const FALLBACK_ALLOWED_HIERARCHY = new Set([
  "search_context",
  "update_progress",
  "find_up",
  "get_agent_profile",
  "get_task",
  "list_work_products",
  "get_work_product",
  "find_subordinates",
  "find_peers",
  "check_work_status",
]);

/**
 * Build the full per-session tool set for a resolved caller. Each tool is a
 * fresh closure over `(ctx, services)` so handlers see the right caller +
 * sid without async-storage threading.
 *
 * Tier breakdown (M9.1 final):
 *
 *   IC (13 tools):
 *     2 memory: save_memory, update_core_memory
 *     9 hierarchy (shared): search_context, update_progress, find_up,
 *       get_agent_profile, get_task, create_work_product,
 *       list_work_products, get_work_product, update_work_product
 *     2 mesh: respond_ask (when targeted by team-tier `ask`),
 *             report_blocker (escalate up to direct parent)
 *
 *   Team / org (24 tools):
 *     2 memory + 15 hierarchy (9 shared + 6 team-only) +
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
      {
        agentId: ctx.caller.agentId,
        sessionId: ctx.beevibeSid,
        hierarchyLevel: ctx.caller.hierarchyLevel,
      },
      { factStore: services.factStore },
    ),
    createUpdateCoreMemoryTool(
      {
        agentId: ctx.caller.agentId,
        hierarchyLevel: ctx.caller.hierarchyLevel,
      },
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
      agentProvisionEventRepo: services.agentProvisionEventRepo,
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

  const all = [...memoryTools, ...hierarchyTools, ...meshTools];
  if (ctx.spawnMode === "server_fallback_mesh") {
    return filterForServerFallback(all);
  }
  return all;
}

/**
 * Restricted tool surface for `spawn_mode='server_fallback_mesh'` sessions.
 * The caller's daemon was offline so we spawned them on the api server with
 * a scratch workspace. They should be able to:
 *   - answer the ask (`respond_ask`, `respond_negotiate`)
 *   - call escalation paths (`report_blocker`, `escalate_to_humans`)
 *   - read context (search_context, get_*, find_*)
 *   - record their own work via `update_progress`
 *
 * They should NOT be able to spawn new tasks, create work products, revise
 * existing tasks, write to escalations, or provision subordinate agents —
 * those mutate state outside the immediate conversation and a transient
 * server-spawned process shouldn't own that surface.
 *
 * Memory writes (save_memory, update_core_memory) are allowed because facts
 * the agent learns during the response are part of the conversation's
 * record, not a side-effect on the team's project state.
 */
function filterForServerFallback(tools: AgentTool[]): AgentTool[] {
  const allowedMesh = new Set([
    "respond_ask",
    "respond_negotiate",
    "report_blocker",
    "escalate_to_humans",
  ]);
  return tools.filter((t) => {
    if (t.name === "save_memory" || t.name === "update_core_memory") return true;
    if (FALLBACK_ALLOWED_HIERARCHY.has(t.name)) return true;
    if (allowedMesh.has(t.name)) return true;
    return false;
  });
}
