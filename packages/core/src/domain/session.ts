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
 * Append-only event captured during a session's CLI run — one row per
 * tool call (and, when the runtime emits them, per agent message / tool
 * result / final summary). Persisted so the session detail page can
 * replay the agent's thinking without keeping the CLI subprocess alive.
 */
export type SessionEventKind = "agent" | "tool_call" | "tool_result" | "summary";

export interface SessionEvent {
  id: string;
  session_id: string;
  kind: SessionEventKind;
  content: string;
  /** Set for tool_call / tool_result kinds. */
  tool_name?: string;
  created_at: Date;
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
  /** Set when this session was kicked off inside a Room. SSE fanout uses it. */
  room_id?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}
