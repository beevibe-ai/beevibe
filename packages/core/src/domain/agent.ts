export type HierarchyLevel = "ic" | "team" | "org";

export const HIERARCHY_LEVELS: readonly HierarchyLevel[] = ["ic", "team", "org"] as const;

export type ReviewPolicy = "require_human" | "auto_done";

export interface RuntimeConfig {
  type: "claude-code";
  model: string;
  max_turns?: number;
  timeout_ms?: number;
  system_prompt_addition?: string;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "claude-code",
  model: "claude-opus-4-7",
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
  created_at: Date;
  updated_at: Date;
}
