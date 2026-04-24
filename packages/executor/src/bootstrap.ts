import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresMemoryFactRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
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
import { createTaskDispatcher } from "./dispatch.js";
import { TaskExecutionWorker } from "./worker.js";

export interface BootstrapConfig {
  databaseUrl: string;
  mcpServerUrl: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  /** Default `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
  /** Default 30_000ms. */
  pollIntervalMs?: number;
}

export interface BootstrapResult {
  worker: TaskExecutionWorker;
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
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const memoryFactRepo = new PostgresMemoryFactRepository(pool);

  // External-service adapters
  const embed = new OpenAIEmbeddingService({ apiKey: cfg.openaiApiKey });
  const llm = new AnthropicLlmProvider({ apiKey: cfg.anthropicApiKey });

  // Workspace + runtime (shared with M6 via the factory)
  const workspaceManager = new LocalWorkspaceManager({
    workspaceRoot: cfg.workspaceRoot,
    mcpServerUrl: cfg.mcpServerUrl,
  });
  const runtimeRegistry = createDefaultRuntimeRegistry();

  // Memory services
  const coreMemory = new CoreMemory({ repo: coreMemoryRepo });
  const factStore = new FactStore({ repo: memoryFactRepo, embed, llm });
  const promoter = new FactPromoter({ llm });

  const makeMemoryAgent = (agentId: string) =>
    createMemoryAgent({ agentId, coreMemory, factStore, promoter, embed });

  // Dispatcher + worker
  const dispatchTask = createTaskDispatcher({
    agentRepo,
    sessionRepo,
    runtimeRegistry,
    makeMemoryAgent,
  });
  const worker = new TaskExecutionWorker({
    agentRepo,
    taskRepo,
    sessionRepo,
    workspaceManager,
    dispatchTask,
    pollIntervalMs: cfg.pollIntervalMs,
  });

  const shutdown = async () => {
    await worker.stop();
    await pool.end();
  };

  return { worker, pool, shutdown };
}
