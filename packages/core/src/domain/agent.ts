export type HierarchyLevel = "ic" | "team" | "org";

export const HIERARCHY_LEVELS: readonly HierarchyLevel[] = ["ic", "team", "org"] as const;

export type ReviewPolicy = "require_human" | "auto_done";

export interface RuntimeConfig {
  type: "claude";
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
  model: "opus",
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
  /**
   * Daemon-runtime binding. Set by agent creation when the user has a
   * registered daemon with a matching CLI; null until then. ON DELETE
   * SET NULL: revoking the runtime unbinds but doesn't delete the agent.
   */
  preferred_runtime_id?: string;
  created_at: Date;
  updated_at: Date;
}
