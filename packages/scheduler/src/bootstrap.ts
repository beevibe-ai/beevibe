import path from "node:path";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresMemoryFactRepository,
  PostgresSessionEventRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresWorkProductRepository,
  createPool,
} from "@beevibe/core/adapters/postgres";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import { OpenAIEmbeddingService } from "@beevibe/core/adapters/openai";
import { AnthropicLlmProvider } from "@beevibe/core/adapters/anthropic";
import { createDefaultRuntimeRegistry } from "@beevibe/core/adapters/runtime-registry";
import {
  CoreMemory,
  FactPromoter,
  FactStore,
  createMemoryAgent,
} from "@beevibe/core/services/memory";
import { TaskService } from "@beevibe/core/services/task-service";
import { DispatchService } from "@beevibe/core/services/dispatch-service";
import { CancelListener } from "./cancel-listener.js";
import { createTaskDispatcher } from "./dispatch.js";
import { ExecutorHealthServer, DEFAULT_HEALTH_PORT } from "./health-server.js";
import { buildPostDispatchHook } from "./post-dispatch.js";
import { TaskExecutionWorker } from "./worker.js";

export interface BootstrapConfig {
  databaseUrl: string;
  mcpServerUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  /** Default `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
  /**
   * Default `process.cwd()/skills`. Path to the canonical skills directory in
   * the repo (M9.3). LocalWorkspaceManager.ensureWorkspace tier-syncs from
   * here into each agent's `<workspace>/.claude/skills/`.
   */
  skillsSourceDir?: string;
  /** Default 30_000ms. */
  pollIntervalMs?: number;
  /** Default 3001. */
  healthPort?: number;
}

export interface BootstrapResult {
  worker: TaskExecutionWorker;
  cancelListener: CancelListener;
  healthServer: ExecutorHealthServer;
  pool: Pool;
  shutdown: () => Promise<void>;
}

/**
 * Composition root for the executor process. Wires pool → repos → adapters →
 * M3 services → per-agent `MemoryAgent` factory → runtime registry →
 * dispatcher → worker. Returns the assembled worker plus a `shutdown`
 * function that stops the poll loop and drains the pool.
 *
 * The MCP server (M6) will do the same wiring in its own bootstrap — it
 * imports the same factories and adapters from `@beevibe/core`, so adding a
 * new runtime (codex, amp, etc.) is one line in the shared
 * `createDefaultRuntimeRegistry` and both composition roots pick it up.
 *
 * No `claudeCommand` / `claudeModel` here: per-agent model flows from
 * `agent.runtime_config.model` through `RuntimeContext.model` at run time.
 * Anything the CLI binary itself needs comes from its own PATH resolution.
 */
export async function bootstrap(cfg: BootstrapConfig): Promise<BootstrapResult> {
  const pool = createPool({ connectionString: cfg.databaseUrl });

  // Repositories (only the ones the executor actually drives; person + work-
  // product are managed by M6's MCP server and M8's web API respectively).
  const agentRepo = new PostgresAgentRepository(pool);
  const taskRepo = new PostgresTaskRepository(pool);
  const sessionRepo = new PostgresSessionRepository(pool);
  const sessionEventRepo = new PostgresSessionEventRepository(pool);
  const workProductRepo = new PostgresWorkProductRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const memoryFactRepo = new PostgresMemoryFactRepository(pool);

  // External-service adapters
  const embed = new OpenAIEmbeddingService({ apiKey: cfg.openaiApiKey });
  const llm = new AnthropicLlmProvider({ apiKey: cfg.anthropicApiKey });

  // Workspace + runtime (shared with M6 via the factory).
  // M9.3: workspaceManager needs the runtime registry to look up the agent's
  // declared runtime per-call and resolve its skills discovery dir; construct
  // registry first so we can pass it in.
  const runtimeRegistry = createDefaultRuntimeRegistry();
  const workspaceManager = new LocalWorkspaceManager({
    workspaceRoot: cfg.workspaceRoot,
    mcpServerUrl: cfg.mcpServerUrl,
    runtimeRegistry,
    skillsSourceDir: cfg.skillsSourceDir ?? path.resolve(process.cwd(), "skills"),
  });

  // Memory services
  const coreMemory = new CoreMemory({ repo: coreMemoryRepo });
  const factStore = new FactStore({ repo: memoryFactRepo, embed, llm });
  const promoter = new FactPromoter({ llm });

  const makeMemoryAgent = (agentId: string) =>
    createMemoryAgent({ agentId, coreMemory, factStore, promoter, embed });

  const taskService = new TaskService({
    taskRepo,
    workProductRepo,
    agentRepo,
    sessionRepo,
  });

  // Phase 4: post-dispatch retry now goes through dispatchService —
  // the daemon (or in-process executor for null-runtime agents) claims
  // the retry session and spawns. Inline AgentSession.run is gone from
  // this path. dispatchService here has no `onSessionInserted` hook
  // because the scheduler isn't connected to the daemon hub; the
  // server-side bootstrap wires the hub callback. Polling daemon
  // wakeup is good enough for retries.
  const dispatchService = new DispatchService({
    agentRepo,
    sessionRepo,
    taskRepo,
  });
  const onSessionComplete = buildPostDispatchHook({
    agentRepo,
    sessionRepo,
    taskRepo,
    taskService,
    dispatchService,
  });

  // Dispatcher + worker
  const dispatchTask = createTaskDispatcher({
    agentRepo,
    sessionRepo,
    sessionEventRepo,
    runtimeRegistry,
    makeMemoryAgent,
    onSessionComplete,
  });
  const worker = new TaskExecutionWorker({
    agentRepo,
    taskRepo,
    sessionRepo,
    workspaceManager,
    dispatchTask,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  // M6.4 cancel-listener: dedicated pg.Client subscribed to `cancel_task`
  // notifications from @beevibe/api's POST /task/:id/cancel. On notification
  // fires worker.cancelTask which aborts the in-flight AbortController and
  // kills the CLI subprocess.
  const cancelListener = new CancelListener({
    connectionString: cfg.databaseUrl,
    worker,
  });

  const healthServer = new ExecutorHealthServer(
    worker,
    cfg.healthPort ?? DEFAULT_HEALTH_PORT,
  );

  const shutdown = async () => {
    await healthServer.stop();
    await cancelListener.stop();
    await worker.stop();
    await pool.end();
  };

  return { worker, cancelListener, healthServer, pool, shutdown };
}
