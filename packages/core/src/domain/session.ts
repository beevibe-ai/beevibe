export type SessionType = "task" | "mesh_ask" | "mesh_negotiate" | "blocker" | "chat" | "run_repo";

export const SESSION_TYPES: readonly SessionType[] = [
  "task",
  "mesh_ask",
  "mesh_negotiate",
  "blocker",
  "chat",
  "run_repo",
] as const;

export type SessionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/**
 * Sessions with no further state transitions. /runtime/done validates
 * its body against this set, dispatchService skips re-queueing tasks
 * already in a matching session-terminal state, etc.
 */
export type TerminalSessionStatus = Exclude<SessionStatus, "pending" | "running">;

export const TERMINAL_SESSION_STATUSES: readonly TerminalSessionStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

export function isTerminalSessionStatus(s: unknown): s is TerminalSessionStatus {
  return (
    typeof s === "string" &&
    (TERMINAL_SESSION_STATUSES as readonly string[]).includes(s)
  );
}

/**
 * Pre-terminal statuses — the session has been accepted but isn't done.
 * Mirror of `TerminalSessionStatus`. Used by the chat history endpoint
 * to flag a conversation's tail session as still-running so the UI can
 * resume its "agent thinking" indicator after navigation.
 */
export type InFlightSessionStatus = Extract<SessionStatus, "pending" | "running">;

export const IN_FLIGHT_SESSION_STATUSES: readonly InFlightSessionStatus[] = [
  "pending",
  "running",
] as const;

export function isInFlightSessionStatus(s: unknown): s is InFlightSessionStatus {
  return (
    typeof s === "string" &&
    (IN_FLIGHT_SESSION_STATUSES as readonly string[]).includes(s)
  );
}

export type SessionSpawnMode = "daemon" | "server_fallback_mesh";

export interface SessionUsage {
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  /**
   * Tokens written to cache (cache miss + write). Charged at ~1.25× base
   * input rate. Captured from Anthropic API's usage object via M9.8.
   */
  cache_creation_input_tokens?: number;
  /**
   * Tokens read from cache (cache hit). Charged at ~0.1× base input rate.
   * Captured from Anthropic API's usage object via M9.8.
   *
   * The three input counters are DISJOINT slices of the same prompt:
   *   total_input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
   *
   * Cache hit ratio = cache_read / total_input. Target >0.7 on the
   * second-onward session of an agent within a 5min cache window
   * (M9.4 briefing restructure).
   */
  cache_read_input_tokens?: number;
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
  /** NULL routes to the server-fallback-mesh path. */
  runtime_id?: string;
  spawn_mode?: SessionSpawnMode;
  /** Maintained by SessionEventRepository.append; consumed by the orphan reaper. */
  last_event_at?: Date;
  /**
   * Set when this session was kicked off from inside a room — SSE
   * fanout uses it to deliver session.event payloads to every member
   * of the room, not just the agent's owner. NULL for ordinary task
   * / chat / mesh sessions.
   */
  room_id?: string;
  /**
   * For mesh-typed sessions (mesh_ask / mesh_negotiate / blocker):
   * the agent that initiated the ask. The mesh activity view + graph
   * read this directly instead of regex-extracting from the intent
   * XML (replaces the SQL `substring(intent FROM 'from="..."')`
   * approach so the column can be indexed).
   */
  caller_agent_id?: string;
  /**
   * Set when this session was spawned from inside another session — e.g. a
   * team agent calling create_task spawns an IC session whose
   * parent_session_id points back at the team session. The chat UI uses
   * this link (together with the session.spawned SSE event) to nest the
   * IC's live transcript inline under the create_task tool_call instead
   * of forcing the user to navigate Tasks → Task → Session.
   *
   * Distinct from `prior_session_id` (resume of the same agent on the
   * same task) and `caller_agent_id` (mesh ask/negotiate initiator).
   */
  parent_session_id?: string;
  /**
   * Chat conversation thread id — the session id of the FIRST turn in
   * the thread. Subsequent turns in the same conversation inherit this
   * value via the INSERT SQL in the postgres SessionRepository
   * (COALESCE(explicit, prior.conversation_id, own id) when
   * type='chat'). NULL for non-chat sessions; they don't participate in
   * a conversation thread.
   *
   * Materializes the head id that `groupIntoConversations` used to walk
   * for in JS, so the views layer can GROUP BY conversation_id without
   * pulling every chat row into application code.
   */
  conversation_id?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}
