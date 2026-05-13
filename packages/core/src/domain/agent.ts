import type { KnownCli } from "./runtime.js";

export type HierarchyLevel = "ic" | "team" | "org";

export const HIERARCHY_LEVELS: readonly HierarchyLevel[] = ["ic", "team", "org"] as const;

export type ReviewPolicy = "require_human" | "auto_done";

export const REVIEW_POLICIES: readonly ReviewPolicy[] = [
  "auto_done",
  "require_human",
] as const;

export interface RuntimeConfig {
  /**
   * CLI tool the agent runs on. Must match a known CLI ({@link KnownCli}).
   * Kept in sync with the bound `runtime.cli` whenever the user changes
   * the agent's `preferred_runtime_id` via POST /agent/:id/runtime — see
   * the runtime.ts doc for why this lookup matters.
   */
  type: KnownCli;
  /**
   * Model alias passed to the CLI via `--model`. Optional: when unset, the
   * CLI uses its own default. Claude Code CLI accepts short aliases (`opus`,
   * `sonnet`, `haiku`) that resolve dynamically to the latest version, or
   * full API model names (`claude-opus-4-7`, etc.) pinned to a specific
   * release.
   */
  model?: string;
  max_turns?: number;
  timeout_ms?: number;
  system_prompt_addition?: string;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "claude",
  // `model` intentionally omitted so the CLI uses its user-configured
  // default (`~/.claude/config`). Per-agent overrides land via the
  // agent settings UI; nothing here should force a specific model on
  // every new agent.
};

export interface Agent {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id?: string;
  hierarchy_level: HierarchyLevel;
  api_key?: string;
  review_policy?: ReviewPolicy;
  runtime_config: RuntimeConfig;
  max_task_sessions?: number;
  max_mesh_sessions?: number;
  /**
   * Per-agent cap on negotiation rounds. Stamped on negotiation rows at
   * creation (initiator's value wins). Default 5 if undefined.
   */
  max_negotiation_rounds?: number;
  /** Preferred runtime binding; null when no daemon registered for the agent's CLI. */
  preferred_runtime_id?: string;
  /**
   * Soft-archive marker (Phase 9). Agents stay in the DB for mesh
   * history + audit; the web list views and the agent picker hide
   * any agent with archived_at set.
   */
  archived_at?: Date;
  created_at: Date;
  updated_at: Date;
}
