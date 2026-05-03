import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresEscalationRepository,
  PostgresMemoryFactRepository,
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
  PostgresPersonRepository,
  PostgresRoomRepository,
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
import { MeshServer } from "./mesh/server.js";
import { BeevibeApiServer } from "./server.js";
import { SessionCache } from "./session-cache.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createTaskRouter } from "./routes/task.js";
import { createEscalationRouter } from "./routes/escalation.js";
import { createViewRouter } from "./routes/view.js";
import { createStreamRouter } from "./routes/stream.js";
import { createChatRouter } from "./routes/chat.js";
import { createMeRouter } from "./routes/me.js";
import { createSignupRouter } from "./routes/signup.js";
import { createRoomRouter } from "./routes/room.js";
import { createStreamAuthMiddleware } from "./auth/middleware.js";
import { SseManager } from "./sse/manager.js";
import { SseListener } from "./sse/listener.js";
import { OwnerLookup } from "./sse/owner-lookup.js";

export interface BootstrapConfig {
  databaseUrl: string;
  /**
   * OpenAI API key for memory recall embeddings. OPTIONAL: when missing,
   * `MemoryAgent.prepareBriefing` returns blocks-only (no fact recall),
   * the `save_memory` MCP tool returns a friendly disabled message to
   * the agent, and existing memory_fact rows are unreachable by vector
   * search. Chat and tasks are unaffected (they spawn the `claude` CLI).
   */
  openaiApiKey?: string;
  /**
   * Anthropic API key for the server-side memory pipeline (FactStore
   * merging + FactPromoter scope-promotion). OPTIONAL: when missing,
   * memory still works — facts are stored, retrieved by vector search,
   * and surfaced in briefings — but near-duplicates won't be merged
   * and promotions won't fire. Chat + tasks are unaffected (those
   * spawn the `claude` CLI which authenticates via `~/.claude/`).
   */
  anthropicApiKey?: string;
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
  const sessionRepo = new PostgresSessionRepository(pool);
  const taskRepo = new PostgresTaskRepository(pool);
  const workProductRepo = new PostgresWorkProductRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const memoryFactRepo = new PostgresMemoryFactRepository(pool);
  const negotiationRepo = new PostgresNegotiationRepository(pool);
  const negotiationRoundRepo = new PostgresNegotiationRoundRepository(pool);
  const escalationRepo = new PostgresEscalationRepository(pool);
  const sessionEventRepo = new PostgresSessionEventRepository(pool);
  const roomRepo = new PostgresRoomRepository(pool);

  // External services. Both keys are optional — memory degrades
  // gracefully without each:
  //   - no OPENAI_API_KEY: prepareBriefing returns blocks-only, save_memory
  //     MCP tool fails-fast with a friendly disabled message
  //   - no ANTHROPIC_API_KEY: FactStore skips merge-on-similar,
  //     FactPromoter returns no-promotion
  // Chat and tasks are unaffected by either — they spawn `claude` directly.
  const embed = cfg.openaiApiKey
    ? new OpenAIEmbeddingService({ apiKey: cfg.openaiApiKey })
    : undefined;
  const llm = cfg.anthropicApiKey
    ? new AnthropicLlmProvider({ apiKey: cfg.anthropicApiKey })
    : undefined;
  if (!embed) {
    console.warn(
      "[bootstrap] OPENAI_API_KEY not set — memory recall + writes disabled. " +
        "Chat and tasks unaffected; agents won't remember across sessions.",
    );
  }
  if (!llm) {
    console.warn(
      "[bootstrap] ANTHROPIC_API_KEY not set — memory fact merging + promotion disabled. " +
        "Chat and tasks unaffected (they use the claude CLI directly).",
    );
  }

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

  // M6.4 escalation service: DB-only writes (no spawning). Re-queues
  // initiator's task + creates synthetic task for counterparty on resolve;
  // executor picks both up.
  const escalationService = new EscalationService({
    escalationRepo,
    negotiationRepo,
    taskRepo,
    agentRepo,
  });

  // M6.4 mesh server: in-process A2A broker. Reuses LocalWorkspaceManager
  // + runtime registry from M5 (shared across executor + api per the M6
  // composition-root design — both processes can spawn target agent CLIs
  // and the mcp-config.json file-existence guard handles cross-process
  // contention).
  const workspaceManager = new LocalWorkspaceManager({
    workspaceRoot: cfg.workspaceRoot,
    mcpServerUrl: cfg.mcpServerUrl,
  });
  const runtimeRegistry = createDefaultRuntimeRegistry();

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
    authDeps: { agentRepo, personRepo },
  });

  // Mount /mcp under the api server. Each call to createMcpRouter wires
  // tools + session lifecycle for that mount point. Auth middleware is
  // applied inside the router.
  const mcpRouter = createMcpRouter({
    authMiddleware: server.getAuthMiddleware(),
    factStore,
    coreMemory,
    coreMemoryRepo,
    sessionCache,
    sessionRepo,
    agentRepo,
    taskRepo,
    workProductRepo,
    taskService,
    escalationService,
    mesh,
    pool,
    makeMemoryAgent,
  });
  server.getApp().use("/mcp", mcpRouter);

  // Self-serve signup. UNAUTHENTICATED — anyone with the public web URL
  // can mint a person + team agent + bv_u_ in one POST. Idempotent on
  // email so users who lose their key can recover. Set
  // BEEVIBE_SIGNUP_ENABLED=0 in .env to disable in locked-down deploys.
  //
  // MUST be mounted BEFORE any router that does `router.use(authMiddleware)`
  // at root (viewRouter, meRouter). Express runs a router's
  // root-level middleware for every request that enters the router,
  // even ones that don't match any of its routes — so a 401-emitting
  // auth check upstream short-circuits before signup gets a chance.
  const signupEnabled = process.env.BEEVIBE_SIGNUP_ENABLED !== "0";
  const signupRouter = createSignupRouter({
    agentRepo,
    personRepo,
    coreMemoryRepo,
    roomRepo,
    enabled: signupEnabled,
  });
  server.getApp().use(signupRouter);

  // Rooms — multi-tenant collaboration spaces. Mounted at /room (matches the
  // singular-noun convention the rest of the api uses for collection roots).
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

  // M8 final integration (#45): SSE live-updates flow.
  // Triggers in migration 1778300000000 emit on `bv_event`; SseListener
  // LISTENs on a dedicated pg.Client and fans out via SseManager;
  // /api/stream pushes to subscribed browsers.
  //
  // Mount BEFORE viewRouter — viewRouter applies authMiddleware at
  // root via `router.use(authMiddleware)`, which runs for every
  // request entering it. The plain auth middleware doesn't see the
  // `?token=` query param the EventSource uses (browsers can't set
  // custom headers on EventSource), so it 401s before /api/stream
  // gets a chance with its own query-aware middleware. Same trap
  // signupRouter hit; same fix.
  const sseManager = new SseManager();
  const ownerLookup = new OwnerLookup(pool);
  const sseListener = new SseListener({
    databaseUrl: cfg.databaseUrl,
    manager: sseManager,
    ownerLookup,
  });
  sseListener.start();
  const streamRouter = createStreamRouter({
    authMiddleware: createStreamAuthMiddleware({ agentRepo, personRepo }),
    sseManager,
  });
  server.getApp().use("/api", streamRouter);

  // M8.2 read-only view routes — bv_u_ only. Direct-to-pool composers in
  // src/views/* return UI-shaped DTOs; no core repos touched on the read
  // path so the agent-execution surface stays uncoupled from web display.
  const viewRouter = createViewRouter({
    authMiddleware: server.getAuthMiddleware(),
    pool,
    agentRepo,
  });
  server.getApp().use(viewRouter);

  // Demo prep: human chat surface. Posting a message synchronously runs
  // one turn of the caller's primary (team/org) agent through
  // AgentSession.run — same machinery the executor uses for tasks.
  // The agent has full hierarchy tool access during the turn.
  const chatRouter = createChatRouter({
    authMiddleware: server.getAuthMiddleware(),
    agentRepo,
    personRepo,
    sessionRepo,
    sessionEventRepo,
    workspaceManager,
    runtimeRegistry,
    makeMemoryAgent,
  });
  server.getApp().use("/chat", chatRouter);

  // Onboarding/identity surface — `/me`, `/me/onboarding/complete`,
  // `/health/runtime`. The web's welcome wizard hits these to decide
  // whether to redirect into onboarding and to verify the chat-path
  // dependencies (claude CLI + OpenAI embeddings).
  const meRouter = createMeRouter({
    authMiddleware: server.getAuthMiddleware(),
    personRepo,
    agentRepo,
    runtimeRegistry,
    embed,
  });
  server.getApp().use(meRouter);

  const shutdown = async (): Promise<void> => {
    sessionCache.stopIdleSweep();
    await sseListener.stop();
    await server.stop();
    await pool.end();
  };

  return { server, sessionCache, pool, shutdown };
}
