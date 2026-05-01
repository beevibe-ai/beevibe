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

/**
 * Structured snapshot of what `MemoryAgent.prepareBriefing` assembled for
 * the session's system prompt. Persisted on the session row so the
 * web's session detail page can render it without re-parsing XML.
 */
export interface SessionBriefingSnapshot {
  block_count: number;
  fact_count: number;
  token_count: number;
  blocks: Array<{ name: string; chars: number; preview: string }>;
  facts: Array<{ scope: "ic" | "team" | "org"; content: string; score: number }>;
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
  briefing?: SessionBriefingSnapshot;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}
