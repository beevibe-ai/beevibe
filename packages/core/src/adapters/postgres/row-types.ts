import type { RuntimeConfig } from "../../domain/agent.js";
import type { SessionSpawnMode, SessionUsage } from "../../domain/session.js";

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  api_key: string | null;
  password_hash: string | null;
  onboarding_completed_at: Date | null;
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
  max_negotiation_rounds: number | null;
  preferred_runtime_id: string | null;
  archived_at: Date | null;
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
  next_dispatch_context: Record<string, unknown> | null;
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
  briefing: Record<string, unknown> | null;
  runtime_id: string | null;
  spawn_mode: SessionSpawnMode;
  last_event_at: Date | null;
  room_id: string | null;
  caller_agent_id: string | null;
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
  description: string;
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
  body: string | null;
  url: string | null;
  provider: string | null;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * List-query projection: `body` content is skipped; `body_bytes` carries
 * the size from `octet_length(body)`. PG returns the latter as bigint, which
 * the node-postgres driver may surface as either number or string depending
 * on the parser config — the mapper coerces.
 */
export type WorkProductListRow = Omit<WorkProductRow, "body"> & {
  body_bytes: number | string;
};

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

export interface NegotiationRow {
  id: string;
  initiator_agent_id: string;
  initiator_session_id: string;
  counterparty_agent_id: string;
  counterparty_session_id: string | null;
  task_id: string | null;
  max_rounds: number;
  rounds_completed: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface NegotiationRoundRow {
  id: string;
  negotiation_id: string;
  round_number: number;
  from_agent_id: string;
  decision: string;
  message: string;
  sent_at: Date;
}

export interface DaemonRow {
  id: string;
  owner_person_id: string;
  external_id: string;
  device_name: string;
  token_hash: string;
  last_seen_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface RuntimeRow {
  id: string;
  daemon_id: string;
  cli: string;
  cli_version: string | null;
  last_heartbeat: Date | null;
  capabilities: Record<string, unknown>;
  created_at: Date;
}

export interface EscalationRow {
  id: string;
  negotiation_id: string;
  initiator_session_id: string;
  counterparty_session_id: string;
  summary: string;
  initiator_proposals: unknown | null;
  initiator_open_questions: string[];
  initiator_submitted_at: Date | null;
  counterparty_proposals: unknown | null;
  counterparty_open_questions: string[];
  counterparty_submitted_at: Date | null;
  escalated_by_role: string;
  status: string;
  resolution_proposal: unknown | null;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
