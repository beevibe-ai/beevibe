import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresMemoryFactRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresWorkProductRepository,
  createPool,
} from "@beevibe/core/adapters/postgres";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { OpenAIEmbeddingService } from "@beevibe/core/adapters/openai";
import { AnthropicLlmProvider } from "@beevibe/core/adapters/anthropic";
import {
  CoreMemory,
  FactPromoter,
  FactStore,
  createMemoryAgent,
  type MemoryAgent,
} from "@beevibe/core/services/memory";
import { TaskService } from "@beevibe/core/services/task-service";
import { BeevibeApiServer } from "./server.js";
import { SessionCache } from "./session-cache.js";
import { createMcpRouter } from "./routes/mcp.js";

export interface BootstrapConfig {
  databaseUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  /** Default 3000. */
  port?: number;
  /** Default 5 minutes. */
  socketTimeoutMs?: number;
  /** Default 1000. */
  sessionCacheMaxEntries?: number;
  /** Default 30 minutes. */
  sessionCacheIdleTimeoutMs?: number;
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

  /**
   * Per-agent MemoryAgent factory. Closed over shared services. Used by:
   *   - `buildInstructions` for human callers (full briefing on initialize)
   *   - SessionCache's onEvict to fire `onTaskComplete` for fact promotion
   *     when a chat session ends (DELETE /mcp or 30-min idle eviction)
   */
  const makeMemoryAgent = (agentId: string): MemoryAgent =>
    createMemoryAgent({ agentId, coreMemory, factStore, promoter, embed });

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
    sessionCache,
    sessionRepo,
    agentRepo,
    taskRepo,
    workProductRepo,
    taskService,
    makeMemoryAgent,
  });
  server.getApp().use("/mcp", mcpRouter);

  const shutdown = async (): Promise<void> => {
    sessionCache.stopIdleSweep();
    await server.stop();
    await pool.end();
  };

  return { server, sessionCache, pool, shutdown };
}
