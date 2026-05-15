import path from "node:path";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresDaemonRepository,
  PostgresEscalationRepository,
  PostgresMemoryFactRepository,
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
  PostgresAgentProvisionEventRepository,
  PostgresPersonRepository,
  PostgresRoomRepository,
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
import { DaemonOrphanReaper } from "@beevibe/core/services/orphan-reaper";
import type { Session } from "@beevibe/core";
import { MeshServer } from "./mesh/server.js";
import { BeevibeApiServer } from "./server.js";
import { SessionCache } from "./session-cache.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createTaskRouter } from "./routes/task.js";
import { createEscalationRouter } from "./routes/escalation.js";
import { createViewRouter } from "./routes/view.js";
import { createStreamRouter } from "./routes/stream.js";
import { createChatRouter } from "./routes/chat.js";
import { createRuntimesRouter } from "./routes/runtimes.js";
import { createSignupRouter } from "./routes/signup.js";
import { createSigninRouter } from "./routes/signin.js";
import { createMeRouter } from "./routes/me.js";
import { createRoomRouter } from "./routes/room.js";
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
  /**
   * Extra cross-origin web origins to allow on top of the localhost
   * defaults. Forwarded to the api server's CORS middleware. Hosted
   * deployments typically pass `parseAllowedOrigins(process.env.BEEVIBE_CORS_ORIGINS)`.
   */
  corsAllowedOrigins?: readonly string[];
}

export interface BootstrapResult {
  server: BeevibeApiServer;
  sessionCache: SessionCache;
  pool: Pool;
  shutdown: () => Promise<void>;
}

/**
 * Composition root for the api server. Mirrors `@beevibe/scheduler`'s
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
  const roomRepo = new PostgresRoomRepository(pool);
  const agentProvisionEventRepo = new PostgresAgentProvisionEventRepository(pool);

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

  // Phase 4 — daemon-facing surface. Hub tracks live WS clients indexed
  // by runtime_id. Built early so dispatchService can wire its
  // onSessionInserted hook through it.
  const daemonHub = new DaemonHub();
  const chatResolver = new ChatResolver();

  // Phase 4 — DispatchService is the single creation point for pending
  // session rows. Call sites (create_task / revise_task / mesh /
  // escalation / post-dispatch retry) call it instead of inserting
  // sessions inline. The onSessionInserted hook fires a best-effort WS
  // push to the bound runtime's daemon — daemons also poll every 30s,
  // so a missed push is at most a 30-second wakeup delay.
  const dispatchService = new DispatchService({
    agentRepo,
    sessionRepo,
    taskRepo,
    onSessionInserted: (session) => {
      if (session.runtime_id) {
        daemonHub.notify(session.runtime_id, session.id);
      }
    },
    // Mesh-typed dispatches whose preferred runtime isn't reachable get
    // demoted to server_fallback_mesh — the server-fallback worker picks
    // them up with a restricted tool surface so cross-team asks don't
    // silently break when the target's daemon is offline. Use `isOnline`
    // (WS or fresh heartbeat) rather than the narrow `hasRuntime` (WS
    // only); a daemon mid-WS-blip is still reachable via the HTTP claim
    // poll within ~30s, no need to demote.
    isRuntimeOnline: (runtimeId) => daemonHub.isOnline(runtimeId),
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

  // M6.4 mesh server. Phase 4: spawn path goes through dispatchService —
  // daemon claims the pending session for daemon-bound targets, executor
  // fallback claims for null-runtime targets.
  const mesh = new MeshServer({
    agentRepo,
    sessionRepo,
    sessionEventRepo,
    negotiationRepo,
    negotiationRoundRepo,
    workspaceManager,
    runtimeRegistry,
    dispatchService,
    makeMemoryAgent,
  });

  // Shared between `onSessionComplete` (graceful failed/cancelled) and
  // `onSessionReaped` (daemon-orphan reaps). If a mesh callee terminates
  // without ever calling respond_ask / respond_negotiate, the waiting
  // caller would otherwise sit out the 5-min resolver timeout and surface
  // as a generic MCP "transport dropped" error. The mesh-failure paths
  // call this so the caller's promise rejects within a tick. Success path
  // is unaffected — respondAsk/respondNegotiate fired `fireResolver` and
  // drained the index before this ever runs. Blocker sessions are
  // fire-and-forget, no resolver to reject.
  const failMeshCalleeIfTerminal = (session: Session, fallbackReason: string) => {
    if (
      (session.type === "mesh_ask" || session.type === "mesh_negotiate") &&
      (session.status === "failed" || session.status === "cancelled")
    ) {
      mesh.failResolverForCalleeSession(session.id, session.error ?? fallbackReason);
    }
  };

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
    ...(cfg.socketTimeoutMs !== undefined ? { socketTimeoutMs: cfg.socketTimeoutMs } : {}),
    authDeps: { agentRepo, personRepo, daemonRepo },
    ...(cfg.corsAllowedOrigins ? { corsAllowedOrigins: cfg.corsAllowedOrigins } : {}),
  });

  // Mount /mcp under the api server. Each call to createMcpRouter wires
  // tools + session lifecycle for that mount point. Auth middleware is
  // applied inside the router.
  const mcpRouter = createMcpRouter({
    authMiddleware: server.getAuthMiddleware(),
    factStore,
    coreMemory,
    coreMemoryRepo,
    agentProvisionEventRepo,
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
    sessionRepo,
    runtimeRepo,
    hub: daemonHub,
    pool,
  });
  server.getApp().use("/task", taskRouter);

  const escalationRouter = createEscalationRouter({
    authMiddleware: server.getAuthMiddleware(),
    escalationService,
    pool,
  });
  server.getApp().use("/escalation", escalationRouter);

  // Phase 8 — self-serve signup. UNAUTHENTICATED. MUST be mounted
  // BEFORE viewRouter (the read-only mount below has no path prefix
  // and applies authMiddleware via `router.use`, so any request that
  // reaches it without a Bearer token gets 401'd before its route
  // matching runs). Set `BEEVIBE_SIGNUP_ENABLED=0` to disable.
  const signupRouter = createSignupRouter({
    agentRepo,
    personRepo,
    coreMemoryRepo,
    enabled: process.env.BEEVIBE_SIGNUP_ENABLED !== "0",
  });
  server.getApp().use(signupRouter);

  // POST /signin — credential exchange. Same gate as signup.
  const signinRouter = createSigninRouter({
    personRepo,
    enabled: process.env.BEEVIBE_SIGNUP_ENABLED !== "0",
  });
  server.getApp().use(signinRouter);

  // M8.2 read-only view routes — bv_u_ only. Direct-to-pool composers in
  // src/views/* return UI-shaped DTOs; no core repos touched on the read
  // path so the agent-execution surface stays uncoupled from web display.
  const viewRouter = createViewRouter({
    authMiddleware: server.getAuthMiddleware(),
    pool,
    agentRepo,
    runtimeRepo,
    daemonRepo,
    coreMemory,
    memoryFactRepo,
  });
  server.getApp().use(viewRouter);


  // Daemon HTTP surface — register / claim / events / done. The chat
  // resolver fires on `session.type === 'chat'` so the awaiting POST
  // /chat returns the agent's response.
  const runtimeRouter = createRuntimeRouter({
    authMiddleware: server.getAuthMiddleware(),
    agentRepo,
    personRepo,
    daemonRepo,
    runtimeRepo,
    sessionRepo,
    sessionEventRepo,
    hub: daemonHub,
    makeMemoryAgent,
    mcpServerUrl: cfg.mcpServerUrl,
    skillsSourceDir: cfg.skillsSourceDir ?? path.resolve(process.cwd(), "skills"),
    onSessionComplete: async (session) => {
      if (session.type === "chat") {
        chatResolver.resolve(session.id, session);
      }
      failMeshCalleeIfTerminal(session, session.status);
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

  // Phase 5 Runtimes panel — bv_u_ surface for Settings → Runtimes.
  // GET /runtimes lists daemons + runtimes (with hub-derived online
  // status); POST /runtimes/:id/revoke revokes a daemon by id.
  const runtimesRouter = createRuntimesRouter({
    authMiddleware: server.getAuthMiddleware(),
    daemonRepo,
    runtimeRepo,
    hub: daemonHub,
  });
  server.getApp().use("/runtimes", runtimesRouter);

  // Phase 8 — onboarding/identity surface (bv_u_).
  // GET /me, POST /me/onboarding/complete, GET /health/runtime.
  const meRouter = createMeRouter({
    authMiddleware: server.getAuthMiddleware(),
    personRepo,
    agentRepo,
    runtimeRegistry,
    embed,
  });
  server.getApp().use(meRouter);

  // Phase 11 — rooms (bv_u_). Multi-tenant chat surface; @-mentioned
  // agents run via AgentSession inline (server-side) — daemon-dispatch
  // for room turns is a follow-up.
  const roomRouter = createRoomRouter({
    authMiddleware: server.getAuthMiddleware(),
    roomRepo,
    agentRepo,
    personRepo,
    sessionRepo,
    sessionEventRepo,
    workspaceManager,
    runtimeRegistry,
    makeMemoryAgent,
  });
  server.getApp().use("/room", roomRouter);

  // Phase 5 daemon-orphan reaper. Marks daemon-bound running sessions
  // failed when both the session's last_event_at AND the runtime's
  // last_heartbeat are stale. For task sessions, fires a crash_recovery
  // dispatch pinned to the same runtime so it resumes when the daemon
  // reconnects. For chat sessions, the onSessionReaped hook unblocks the
  // awaiting POST /chat via the chat resolver.
  const daemonOrphanReaper = new DaemonOrphanReaper({
    sessionRepo,
    taskRepo,
    dispatchService,
    onSessionReaped: (session) => {
      if (session.type === "chat") {
        chatResolver.resolve(session.id, session);
      }
      failMeshCalleeIfTerminal(session, "daemon_orphaned");
    },
  });
  void daemonOrphanReaper.start();

  // M8 final integration (#45): SSE live-updates flow.
  // Triggers in migration 1778300000000 emit on `bv_event`; SseListener
  // LISTENs on a dedicated pg.Client and fans out via SseManager;
  // /api/stream pushes to subscribed browsers.
  const sseManager = new SseManager();
  const ownerLookup = new OwnerLookup(pool);

  // Cross-process mesh fast-fail. The api server's `onSessionComplete`
  // hook only fires for sessions claimed via /runtime/done (daemon path).
  // `spawn_mode='server_fallback_mesh'` callees run inside the scheduler
  // binary, so a failure there never reaches MeshServer through the
  // in-process callback. Subscribe to the existing `session.updated`
  // pg_notify and fast-fail any pending caller waiting on that row. The
  // `hasPendingCalleeSession` guard short-circuits the 99% case (every
  // chat / task / unrelated session.updated) before touching the DB.
  const forwardMeshFailFromSession = (event: { event: string; id: string }) => {
    if (event.event !== "session.updated") return;
    if (!mesh.hasPendingCalleeSession(event.id)) return;
    void sessionRepo
      .findById(event.id)
      .then((session) => {
        if (session) failMeshCalleeIfTerminal(session, session.status);
      })
      .catch((err: unknown) => {
        console.error(
          "[sse] mesh-fail lookup failed:",
          err instanceof Error ? err.message : err,
        );
      });
  };

  const sseListener = new SseListener({
    databaseUrl: cfg.databaseUrl,
    manager: sseManager,
    ownerLookup,
    onEvent: forwardMeshFailFromSession,
  });
  sseListener.start();
  const streamRouter = createStreamRouter({
    authMiddleware: createStreamAuthMiddleware({ agentRepo, personRepo, daemonRepo }),
    sseManager,
  });
  server.getApp().use("/api", streamRouter);

  const shutdown = async (): Promise<void> => {
    sessionCache.stopIdleSweep();
    await daemonOrphanReaper.stop();
    await sseListener.stop();
    await runtimeWsServer.stop();
    await server.stop();
    await pool.end();
  };

  return { server, sessionCache, pool, shutdown };
}
