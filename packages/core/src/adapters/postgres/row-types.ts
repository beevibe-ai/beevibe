import type { RuntimeConfig } from "../../domain/agent.js";
import type { SessionUsage } from "../../domain/session.js";

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  api_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id: string | null;
  hierarchy_level: string;
  api_key: string | null;
  review_policy: string | null;
  runtime_config: RuntimeConfig;
  max_task_sessions: number | null;
  max_mesh_sessions: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_id: string | null;
  creator_id: string;
  creator_type: string;
  parent_task_id: string | null;
  result_summary: string | null;
  blocker_agent_id: string | null;
  blocker_reason: string | null;
  repo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  prior_session_id: string | null;
  type: string;
  status: string;
  intent: string;
  cli_session_id: string | null;
  workspace_path: string | null;
  process_pid: number | null;
  process_group_id: number | null;
  result_summary: string | null;
  exit_code: number | null;
  error: string | null;
  usage: SessionUsage | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface CoreMemoryBlockRow {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_limit: number;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WorkProductRow {
  id: string;
  task_id: string;
  agent_id: string;
  type: string;
  title: string;
  summary: string | null;
  url: string | null;
  provider: string | null;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryFactRow {
  id: string;
  agent_id: string;
  scope: string;
  fact_type: string;
  content: string;
  /** pgvector returns vectors as string like "[0.1,0.2,…]"; adapters parse into number[]. */
  embedding: string;
  source_session_ids: string[];
  created_at: Date;
}
