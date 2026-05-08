import path from "node:path";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresDaemonRepository,
  PostgresEscalationRepository,
  PostgresMemoryFactRepository,
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
  PostgresPersonRepository,
  PostgresRuntimeRepository,
  PostgresSessionEventRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresWorkProductRepository,
  createPool,
} from "@beevibe/core/adapters/postgres";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { OpenAIEmbeddingService } from "@beevibe/core/adapters/openai";
import { AnthropicLlmProvider } from "@beevibe/core/adapters/anthropic";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import { createDefaultRuntimeRegistry } from "@beevibe/core/adapters/runtime-registry";
import {
  CoreMemory,
  FactPromoter,
  FactStore,
  createMemoryAgent,
  type MemoryAgent,
} from "@beevibe/core/services/memory";
import { TaskService } from "@beevibe/core/services/task-service";
import { EscalationService } from "@beevibe/core/services/escalation-service";
import { DispatchService } from "@beevibe/core/services/dispatch-service";
import { MeshServer } from "./mesh/server.js";
import { BeevibeApiServer } from "./server.js";
import { SessionCache } from "./session-cache.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createTaskRouter } from "./routes/task.js";
import { createEscalationRouter } from "./routes/escalation.js";
import { createViewRouter } from "./routes/view.js";
import { createStreamRouter } from "./routes/stream.js";
import { createChatRouter } from "./routes/chat.js";
import { createStreamAuthMiddleware } from "./auth/middleware.js";
import { ChatResolver } from "./runtime/chat-resolver.js";
import { DaemonHub } from "./runtime/hub.js";
import { createRuntimeRouter } from "./runtime/router.js";
import { RuntimeWsServer } from "./runtime/ws-server.js";
import { SseManager } from "./sse/manager.js";
import { SseListener } from "./sse/listener.js";
import { OwnerLookup } from "./sse/owner-lookup.js";

export interface BootstrapConfig {
  databaseUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  /**
   * MCP server URL embedded in per-agent mcp-config.json files. Used by
   * mesh-spawned target agents to call back into this api server. Same
   * value as the executor's BEEVIBE_MCP_SERVER_URL env (so both binaries
   * write identical mcp-config.json contents — file-existence-check makes
   * both processes safe).
   */
  mcpServerUrl: string;
  /** Default 3000. */
  port?: number;
  /** Default 5 minutes. */
  socketTimeoutMs?: number;
  /** Default 1000. */
  sessionCacheMaxEntries?: number;
  /** Default 30 minutes. */
  sessionCacheIdleTimeoutMs?: number;
  /** Default `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
  /**
   * Default `process.cwd()/skills`. Path to the canonical skills directory in
   * the repo (M9.3). LocalWorkspaceManager.ensureWorkspace tier-syncs from
   * here into each agent's `<workspace>/.claude/skills/`.
   */
  skillsSourceDir?: string;
}

export interface BootstrapResult {
  server: BeevibeApiServer;
  sessionCache: SessionCache;
  pool: Pool;
  shutdown: () => Promise<void>;
}

/**
 * Composition root for the api server. Mirrors `@beevibe/executor`'s
 * bootstrap so wiring is symmetric across the two binary composition roots.
 *
 * M6.1: pool + 3 repos + session cache + api server + Bearer auth.
 * M6.2: + memory services (FactStore, CoreMemory, FactPromoter) + per-agent
 *       MemoryAgent factory + MCP router with `save_memory` /
 *       `update_core_memory` tools mounted at /mcp.
 * M6.3: + task + work-product repos + TaskService. The MCP router now
 *       assembles 14 tools (2 memory + 8 IC-shared hierarchy + 4 team-only)
 *       per session, tier-gated by caller.hierarchyLevel.
 */
export async function bootstrap(cfg: BootstrapConfig): Promise<BootstrapResult> {
  const pool = createPool({ connectionString: cfg.databaseUrl });

  const agentRepo = new PostgresAgentRepository(pool);
  const personRepo = new PostgresPersonRepository(pool);
  const daemonRepo = new PostgresDaemonRepository(pool);
  const runtimeRepo = new PostgresRuntimeRepository(pool);
  const sessionRepo = new PostgresSessionRepository(pool);
  const sessionEventRepo = new PostgresSessionEventRepository(pool);
  const taskRepo = new PostgresTaskRepository(pool);
  const workProductRepo = new PostgresWorkProductRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const memoryFactRepo = new PostgresMemoryFactRepository(pool);
  const negotiationRepo = new PostgresNegotiationRepository(pool);
  const negotiationRoundRepo = new PostgresNegotiationRoundRepository(pool);
  const escalationRepo = new PostgresEscalationRepository(pool);

  // External services (LLM + embeddings) for memory pipeline
  const embed = new OpenAIEmbeddingService({ apiKey: cfg.openaiApiKey });
  const llm = new AnthropicLlmProvider({ apiKey: cfg.anthropicApiKey });

  // M3 memory services
  const coreMemory = new CoreMemory({ repo: coreMemoryRepo });
  const factStore = new FactStore({ repo: memoryFactRepo, embed, llm });
  const promoter = new FactPromoter({ llm });

  // M3+M6.4 task service (review_policy gate, work-product CRUD, parent
  // rollup, plus the M6.4 approve/reject/revise split — reviseTask needs
  // sessionRepo to look up priorSessionId for next_dispatch_context).
  const taskService = new TaskService({
    taskRepo,
    workProductRepo,
    agentRepo,
    sessionRepo,
  });

  // Phase 4 — DispatchService is the single creation point for pending
  // session rows. Call sites (create_task / revise_task / mesh /
  // escalation / post-dispatch retry) call it instead of inserting
  // sessions inline. Daemon hub notify is wired below after the hub
  // is constructed.
  const dispatchService = new DispatchService({
    agentRepo,
    sessionRepo,
    taskRepo,
  });

  // M6.4 escalation service: DB-only writes for the resolution + dispatch
  // for both initiator and counterparty post-resolution sessions.
  const escalationService = new EscalationService({
    escalationRepo,
    negotiationRepo,
    taskRepo,
    agentRepo,
    dispatchService,
  });

  // M6.4 mesh server: in-process A2A broker. Reuses LocalWorkspaceManager
  // + runtime registry from M5 (shared across executor + api per the M6
  // composition-root design — both processes can spawn target agent CLIs
  // and the mcp-config.json file-existence guard handles cross-process
  // contention). M9.3: workspaceManager needs the runtime registry to look
  // up each agent's declared runtime per-call; construct registry first.
  const runtimeRegistry = createDefaultRuntimeRegistry();
  const workspaceManager = new LocalWorkspaceManager({
    workspaceRoot: cfg.workspaceRoot,
    mcpServerUrl: cfg.mcpServerUrl,
    runtimeRegistry,
    skillsSourceDir: cfg.skillsSourceDir ?? path.resolve(process.cwd(), "skills"),
  });

  /**
   * Per-agent MemoryAgent factory. Closed over shared services. Used by:
   *   - `buildInstructions` for human callers (full briefing on initialize)
   *   - SessionCache's onEvict to fire `onTaskComplete` for fact promotion
   *     when a chat session ends (DELETE /mcp or 30-min idle eviction)
   */
  const makeMemoryAgent = (agentId: string): MemoryAgent =>
    createMemoryAgent({ agentId, coreMemory, factStore, promoter, embed });

  // M6.4 mesh server (depends on makeMemoryAgent for spawned target sessions).
  const mesh = new MeshServer({
    agentRepo,
    sessionRepo,
    sessionEventRepo,
    negotiationRepo,
    negotiationRoundRepo,
    workspaceManager,
    runtimeRegistry,
    makeMemoryAgent,
  });

  /**
   * The session cache's onEvict needs to call `onTaskComplete(beevibeSid)`,
   * but `onTaskComplete` lives on a per-agent MemoryAgent. We don't know
   * the agent_id here from beevibeSid alone — so we do a quick session
   * lookup to find the agent, then build the MemoryAgent for that agent
   * and fire promotion. This runs out-of-band (idle sweep / DELETE), not
   * on the hot path.
   */
  const sessionCache = new SessionCache({
    sessionRepo,
    maxEntries: cfg.sessionCacheMaxEntries,
    idleTimeoutMs: cfg.sessionCacheIdleTimeoutMs,
    onEvict: async (beevibeSid) => {
      const session = await sessionRepo.findById(beevibeSid);
      if (!session) return;
      const memoryAgent = makeMemoryAgent(session.agent_id);
      await memoryAgent.onTaskComplete(beevibeSid);
    },
  });
  sessionCache.startIdleSweep();

  const server = new BeevibeApiServer({
    port: cfg.port ?? 3000,
    socketTimeoutMs: cfg.socketTimeoutMs,
    authDeps: { agentRepo, personRepo, daemonRepo },
  });

  // Mount /mcp under the api server. Each call to createMcpRouter wires
  // tools + session lifecycle for that mount point. Auth middleware is
  // applied inside the router.
  const mcpRouter = createMcpRouter({
    authMiddleware: server.getAuthMiddleware(),
    factStore,
    coreMemory,
    sessionCache,
    sessionRepo,
    agentRepo,
    taskRepo,
    workProductRepo,
    taskService,
    escalationService,
    dispatchService,
    mesh,
    pool,
    makeMemoryAgent,
  });
  server.getApp().use("/mcp", mcpRouter);

  // M6.4 human REST routes — bv_u_ only.
  const taskRouter = createTaskRouter({
    authMiddleware: server.getAuthMiddleware(),
    taskRepo,
    taskService,
    pool,
  });
  server.getApp().use("/task", taskRouter);

  const escalationRouter = createEscalationRouter({
    authMiddleware: server.getAuthMiddleware(),
    escalationService,
    pool,
  });
  server.getApp().use("/escalation", escalationRouter);

  // M8.2 read-only view routes — bv_u_ only. Direct-to-pool composers in
  // src/views/* return UI-shaped DTOs; no core repos touched on the read
  // path so the agent-execution surface stays uncoupled from web display.
  const viewRouter = createViewRouter({
    authMiddleware: server.getAuthMiddleware(),
    pool,
    agentRepo,
  });
  server.getApp().use(viewRouter);


  // Phase 4 — daemon-facing surface. The hub is in-memory; tracks live WS
  // clients indexed by runtime_id. HTTP endpoints work without a live
  // socket — daemons can claim via HTTP poll alone if WS push fails.
  // The chat resolver is keyed by session_id; /runtime/done fires it so
  // the awaiting POST /chat returns the agent's response.
  const daemonHub = new DaemonHub();
  const chatResolver = new ChatResolver();
  const runtimeRouter = createRuntimeRouter({
    authMiddleware: server.getAuthMiddleware(),
    agentRepo,
    daemonRepo,
    runtimeRepo,
    sessionRepo,
    sessionEventRepo,
    hub: daemonHub,
    makeMemoryAgent,
    mcpServerUrl: cfg.mcpServerUrl,
    onSessionComplete: async (session) => {
      if (session.type === "chat") {
        chatResolver.resolve(session.id, session);
      }
      // Future: mesh resolver for cross-instance mesh, post-dispatch
      // hook for parent-task rollup, etc.
    },
  });
  server.getApp().use("/runtime", runtimeRouter);

  // WSS upgrade for daemon push. Hangs off the same http.Server as Express;
  // attach() registers a one-shot upgrade listener that filters by path.
  const runtimeWsServer = new RuntimeWsServer({
    hub: daemonHub,
    authDeps: { agentRepo, personRepo, daemonRepo },
    runtimeRepo,
  });
  runtimeWsServer.attach(server.getHttpServer());

  // Phase 4 chat surface — daemon-first. dispatchService inserts a
  // pending session, the daemon claims it (or executor for null-runtime
  // agents), and /runtime/done fires chatResolver to unblock POST /chat.
  const chatRouter = createChatRouter({
    authMiddleware: server.getAuthMiddleware(),
    agentRepo,
    personRepo,
    sessionRepo,
    dispatchService,
    chatResolver,
    hub: daemonHub,
  });
  server.getApp().use("/chat", chatRouter);

  // M8 final integration (#45): SSE live-updates flow.
  // Triggers in migration 1778300000000 emit on `bv_event`; SseListener
  // LISTENs on a dedicated pg.Client and fans out via SseManager;
  // /api/stream pushes to subscribed browsers.
  const sseManager = new SseManager();
  const ownerLookup = new OwnerLookup(pool);
  const sseListener = new SseListener({
    databaseUrl: cfg.databaseUrl,
    manager: sseManager,
    ownerLookup,
  });
  sseListener.start();
  const streamRouter = createStreamRouter({
    authMiddleware: createStreamAuthMiddleware({ agentRepo, personRepo, daemonRepo }),
    sseManager,
  });
  server.getApp().use("/api", streamRouter);

  const shutdown = async (): Promise<void> => {
    sessionCache.stopIdleSweep();
    await sseListener.stop();
    await runtimeWsServer.stop();
    await server.stop();
    await pool.end();
  };

  return { server, sessionCache, pool, shutdown };
}
