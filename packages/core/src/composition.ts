/**
 * Composition-root scaffolding shared by the `api` and `scheduler`
 * bootstraps.
 *
 * Both processes assemble the same two stacks from the same config fields
 * before they diverge into their own wiring: the memory pipeline (embedding
 * service → LLM → CoreMemory / FactStore / FactPromoter → per-agent
 * `MemoryAgent` factory) and the workspace pair (runtime registry →
 * `LocalWorkspaceManager`). The `scheduler` bootstrap's own doc comment
 * already said as much — "the MCP server will do the same wiring in its own
 * bootstrap" — but the wiring itself stayed duplicated, in a different order
 * in each file, with the same defaulting expression written out three times.
 *
 * As with `process-lifecycle.ts`, this takes only the parts that were
 * identical. Each bootstrap keeps its own repositories, its own services and
 * its own start order.
 */

import path from "node:path";
import { LocalWorkspaceManager } from "./adapters/local-workspace/index.js";
import { OpenAIEmbeddingService } from "./adapters/openai/index.js";
import { AnthropicLlmProvider } from "./adapters/anthropic/index.js";
import { createDefaultRuntimeRegistry } from "./adapters/runtime-registry.js";
import {
  CoreMemory,
  FactPromoter,
  FactStore,
  createMemoryAgent,
  type MemoryAgent,
} from "./services/memory/index.js";
import type { CoreMemoryBlockRepository } from "./ports/core-memory-repo.js";
import type { MemoryFactRepository } from "./ports/memory-fact-repo.js";
import type { RuntimeRegistry } from "./ports/runtime.js";

/**
 * Resolve the canonical skills directory a bootstrap tier-syncs from.
 *
 * The `?? path.resolve(process.cwd(), "skills")` fallback was written out at
 * three call sites (api twice, scheduler once) — meaning a change to where
 * skills live had three edits and could half-land, with the runtime router
 * reading one directory and the workspace manager another in the same
 * process.
 */
export function resolveSkillsSourceDir(configured?: string): string {
  return configured ?? path.resolve(process.cwd(), "skills");
}

export interface MemoryStackConfig {
  coreMemoryRepo: CoreMemoryBlockRepository;
  memoryFactRepo: MemoryFactRepository;
  openaiApiKey: string;
  anthropicApiKey: string;
}

export interface MemoryStack {
  embed: OpenAIEmbeddingService;
  llm: AnthropicLlmProvider;
  coreMemory: CoreMemory;
  factStore: FactStore;
  promoter: FactPromoter;
  /**
   * Per-agent `MemoryAgent` factory, closed over the shared services above.
   * Both processes hand this to anything that needs to brief an agent or
   * promote its facts when a session ends.
   */
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

/** Embeddings + LLM + the three memory services + the per-agent factory. */
export function createMemoryStack(cfg: MemoryStackConfig): MemoryStack {
  const embed = new OpenAIEmbeddingService({ apiKey: cfg.openaiApiKey });
  const llm = new AnthropicLlmProvider({ apiKey: cfg.anthropicApiKey });

  const coreMemory = new CoreMemory({ repo: cfg.coreMemoryRepo });
  const factStore = new FactStore({ repo: cfg.memoryFactRepo, embed, llm });
  const promoter = new FactPromoter({ llm });

  return {
    embed,
    llm,
    coreMemory,
    factStore,
    promoter,
    makeMemoryAgent: (agentId: string): MemoryAgent =>
      createMemoryAgent({ agentId, coreMemory, factStore, promoter, embed }),
  };
}

export interface WorkspaceStackConfig {
  /** Defaults to `~/.beevibe/workspaces` inside LocalWorkspaceManager. */
  workspaceRoot?: string;
  mcpServerUrl: string;
  /** Passed through {@link resolveSkillsSourceDir}. */
  skillsSourceDir?: string;
}

export interface WorkspaceStack {
  runtimeRegistry: RuntimeRegistry;
  workspaceManager: LocalWorkspaceManager;
}

/**
 * Runtime registry + workspace manager, in that order — the manager needs
 * the registry to resolve each agent's skills discovery dir per call, so
 * the two can't be constructed independently.
 *
 * Adding a runtime stays one line in `createDefaultRuntimeRegistry`, which
 * every composition root now reaches through here.
 */
export function createWorkspaceStack(cfg: WorkspaceStackConfig): WorkspaceStack {
  const runtimeRegistry = createDefaultRuntimeRegistry();
  const workspaceManager = new LocalWorkspaceManager({
    workspaceRoot: cfg.workspaceRoot,
    mcpServerUrl: cfg.mcpServerUrl,
    runtimeRegistry,
    skillsSourceDir: resolveSkillsSourceDir(cfg.skillsSourceDir),
  });
  return { runtimeRegistry, workspaceManager };
}
