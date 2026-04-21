export type SessionType = "task" | "mesh_ask" | "mesh_negotiate" | "blocker" | "chat";

export const SESSION_TYPES: readonly SessionType[] = [
  "task",
  "mesh_ask",
  "mesh_negotiate",
  "blocker",
  "chat",
] as const;

export type SessionStatus = "running" | "succeeded" | "failed" | "cancelled";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export interface SessionUsage {
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
}

export interface Session {
  id: string;
  agent_id: string;
  task_id?: string;
  prior_session_id?: string;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  cli_session_id?: string;
  workspace_path?: string;
  process_pid?: number;
  process_group_id?: number;
  result_summary?: string;
  exit_code?: number;
  error?: string;
  usage?: SessionUsage;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}
