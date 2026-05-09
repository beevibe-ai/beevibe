import { fetchJson } from "./http";
import type {
  TaskDetail,
  AgentDetail,
  DashboardSummary,
  MeshOverview,
} from "./types";
import type { TaskListItem } from "@/lib/types/tasks";
import type { AgentDisplay } from "@/lib/types/agents";
import type { SessionDisplay } from "@/lib/types/sessions";
import type { MemoryFactDisplay } from "@/lib/types/memory-facts";
import type { PromotionEvent } from "@/lib/types/promotion-events";
import type { InboxItem } from "@/lib/types/inbox";
import type {
  HierarchyLevel,
  MemoryScope,
  SessionStatus,
  SessionType,
  Task,
  TaskPriority,
} from "@beevibe/core";
import type { Lifecycle } from "@/lib/tasks-grouping";

export type TaskView = "all" | "mine" | "sprint" | "timeline";

export interface TaskListFilter {
  lifecycle?: Lifecycle;
  assignee_id?: string;
  view?: TaskView;
}

export interface ReadOptions {
  signal?: AbortSignal;
}

export interface ApproveTaskInput {
  result_summary?: string;
}
export interface RejectTaskInput {
  result_summary?: string;
}
export interface ReviseTaskInput {
  feedback: string;
}

export interface CancelTaskInput {
  reason?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee_id?: string;
  parent_task_id?: string;
}

export interface MeResponse {
  person: {
    id: string;
    name: string;
    email: string | null;
    onboarding_completed_at: string | null;
  };
  primary_agent: {
    id: string;
    name: string;
    hierarchy: "ic" | "team" | "org";
  } | null;
  needs_onboarding: boolean;
}

export interface HealthResponse {
  ok: boolean;
  /** `claude` CLI presence — chat agents spawn as CLI subprocesses. */
  claude_cli: { ok: boolean; message?: string };
  /**
   * OpenAI embeddings — used by memory briefing's vector recall.
   * `skipped: true` means no `OPENAI_API_KEY` was configured at boot;
   * memory writes will return a friendly disabled message and recall
   * returns blocks-only briefings. Chat works either way.
   */
  openai: { ok: boolean; skipped?: boolean; message?: string };
}

export interface ChatSendInput {
  message: string;
  /** Previous turn's session id — enables `--resume` continuity. */
  prior_session_id?: string;
  /**
   * Caller-supplied session id for the new turn. Lets the chat UI subscribe
   * to `session.step` SSE events for this id BEFORE the server starts the
   * run, so streaming step rendering doesn't miss the early events.
   */
  session_id?: string;
}

export interface SuggestedAction {
  /** Short text shown on the chip. */
  label: string;
  /** Optional longer message sent on click — defaults to label. */
  prompt?: string;
}

export interface ChatTurnResponse {
  ok: true;
  agent: { id: string; name: string; hierarchy: "ic" | "team" | "org" };
  session_id: string;
  response: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  /** Entity ids the agent referenced in its response (task_*, agent_*, sess_*). */
  view_refs: string[];
  /**
   * If the agent emitted an `<open_view path="..."/>` directive, the
   * resolved path is here so the chat UI can render a prominent "Open this →" CTA.
   */
  open_view?: { path: string; label?: string };
  /**
   * If the agent ended its reply with `<suggest_action>` directives, each
   * label becomes a clickable chip below the bubble that re-sends the
   * label as the next user message.
   */
  suggested_actions?: SuggestedAction[];
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  session_id?: string;
  view_refs?: string[];
  open_view?: { path: string; label?: string };
  suggested_actions?: SuggestedAction[];
}

export interface ChatHistoryResponse {
  ok: true;
  agent: { id: string; name: string; hierarchy: "ic" | "team" | "org" } | null;
  messages: ChatHistoryMessage[];
  /** The most recent session id, used to chain `prior_session_id` on the next turn. */
  prior_session_id: string | null;
  /** Head session id of the conversation these messages belong to. */
  conversation_id: string | null;
}

export interface ChatConversationSummary {
  /** Head session id of the chain (the first turn). */
  head_id: string;
  /** First user message, used as the title in conversation pickers. */
  title: string;
  /** Number of turns (sessions) in the chain. */
  turn_count: number;
  /** ISO timestamp of the most recent turn in the chain. */
  last_at: string;
  /** Brief preview of the latest agent reply (or user intent if no reply yet). */
  last_preview: string;
}

export interface ChatConversationsResponse {
  ok: true;
  conversations: ChatConversationSummary[];
}

export interface SignupInput {
  name: string;
  email: string;
}

export interface Room {
  id: string;
  name: string;
  owner_person_id: string;
  created_at: string;
  updated_at: string;
}

export type RoomMemberDetail =
  | { kind: "person"; id: string; name: string; email: string | null }
  | {
      kind: "agent";
      id: string;
      name: string;
      hierarchy: HierarchyLevel;
      owner_person_id: string;
    };

export interface RoomMessage {
  id: string;
  room_id: string;
  kind: "human" | "agent";
  content: string;
  sender_person_id?: string;
  sender_agent_id?: string;
  session_id?: string;
  view_refs?: string[];
  open_view?: { path: string; label?: string };
  suggested_actions?: SuggestedAction[];
  created_at: string;
}

export interface RoomTypingStep {
  event_id: string;
  kind: "agent" | "tool_call" | "tool_result" | "summary";
  tool_name: string | null;
  content: string;
}

export interface RoomTypingIndicator {
  session_id: string;
  agent_id: string;
  agent_name: string;
  started_at: string;
  recent_steps: RoomTypingStep[];
  total_steps: number;
}

export interface RoomDetail {
  ok: true;
  room: Room;
  members: RoomMemberDetail[];
  messages: RoomMessage[];
  typing?: RoomTypingIndicator[];
}

export interface SignupResponse {
  ok: true;
  /** Freshly minted (or recovered) bv_u_ key. Persist client-side and use as Bearer. */
  api_key: string;
  person: { id: string; name: string; email: string };
  primary_agent: { id: string; name: string; hierarchy: "ic" | "team" | "org" };
  /** True when an existing person with this email was returned instead of created. */
  existed: boolean;
}

export interface WorkProductDetail {
  id: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  agent_id: string;
  agent_label: string;
  type:
    | "pull_request"
    | "branch"
    | "commit"
    | "document"
    | "analysis"
    | "report"
    | "design"
    | "artifact"
    | "preview";
  title: string;
  summary?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  /** Inlined file contents when url is file://. Render as markdown. */
  body?: string;
  url_is_local: boolean;
  created_at: string;
  updated_at: string;
}

export interface ActivityEntry {
  id: string;
  short_id: string;
  agent_id: string;
  agent_label: string;
  agent_hierarchy: HierarchyLevel;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  task_id: string | null;
  task_title: string | null;
  task_short_id: string | null;
  started_at: string;
  duration_label: string;
}

export interface RuntimePanelEntry {
  id: string;
  cli: string;
  cli_version: string | null;
  last_heartbeat: string | null;
  /** True iff a daemon WS client subscribed to this runtime is connected. */
  online: boolean;
  capabilities: Record<string, unknown>;
  created_at: string;
}

export interface DaemonPanelEntry {
  id: string;
  device_name: string;
  external_id: string;
  last_seen_at: string | null;
  created_at: string;
  runtimes: RuntimePanelEntry[];
}

export interface RuntimesListResponse {
  ok: true;
  daemons: DaemonPanelEntry[];
}

export interface RevokeDaemonResponse {
  ok: true;
  daemon_id: string;
  /** True when the daemon was already revoked before this call (idempotent). */
  already_revoked: boolean;
}

export type EscalationResolveInput =
  | {
      source: "initiator" | "counterparty";
      source_index: number;
      edited_title?: string;
      edited_description?: string;
      resolution_notes?: string;
    }
  | {
      source: "human";
      title: string;
      description: string;
      resolution_notes?: string;
    };

export const api = {
  tasks: {
    list: (filter: TaskListFilter = {}, opts: ReadOptions = {}) =>
      fetchJson<TaskListItem[]>("/task", { query: { ...filter }, signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<TaskDetail>(`/task/${encodeURIComponent(id)}`, { signal: opts.signal }),
    approve: (id: string, input: ApproveTaskInput = {}) =>
      fetchJson<{ ok: true; task: Pick<Task, "id" | "status"> }>(
        `/task/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: input },
      ),
    reject: (id: string, input: RejectTaskInput = {}) =>
      fetchJson<{ ok: true; task: Pick<Task, "id" | "status"> }>(
        `/task/${encodeURIComponent(id)}/reject`,
        { method: "POST", body: input },
      ),
    revise: (id: string, input: ReviseTaskInput) =>
      fetchJson<{ ok: true; task: Pick<Task, "id" | "status"> }>(
        `/task/${encodeURIComponent(id)}/revise`,
        { method: "POST", body: input },
      ),
    cancel: (id: string, input: CancelTaskInput = {}) =>
      fetchJson<{ ok: true; task_id: string; note: string }>(
        `/task/${encodeURIComponent(id)}/cancel`,
        { method: "POST", body: input },
      ),
    // Backend hasn't shipped POST /task (create) yet — see #30.
    create: (input: CreateTaskInput) =>
      fetchJson<Task>("/task", { method: "POST", body: input }),
  },
  agents: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<AgentDisplay[]>("/agent", { signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<AgentDetail>(`/agent/${encodeURIComponent(id)}`, { signal: opts.signal }),
  },
  sessions: {
    /** Path param is the 6-char short_id (no '#'). */
    get: (shortId: string, opts: ReadOptions = {}) =>
      fetchJson<SessionDisplay>(`/session/${encodeURIComponent(shortId)}`, {
        signal: opts.signal,
      }),
  },
  memory: {
    listFacts: (filter: { scope?: MemoryScope } = {}, opts: ReadOptions = {}) =>
      fetchJson<MemoryFactDisplay[]>("/memory/fact", {
        query: { ...filter },
        signal: opts.signal,
      }),
  },
  // Surfaces below depend on backend slices that haven't shipped yet
  // (dashboard/mesh need a data/display split; threads/promotions lack a
  // domain). They'll 404 against the current api server and the page-level
  // empty states keep showing. Tracked in follow-ups to #30.
  promotions: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<PromotionEvent[]>("/promotion", { signal: opts.signal }),
  },
  mesh: {
    overview: (filter: { since?: string } = {}, opts: ReadOptions = {}) =>
      fetchJson<MeshOverview>("/mesh", { query: { ...filter }, signal: opts.signal }),
  },
  dashboard: {
    summary: (opts: ReadOptions = {}) =>
      fetchJson<DashboardSummary>("/dashboard", { signal: opts.signal }),
  },
  chat: {
    /**
     * Send one turn to the caller's primary agent. Server runs
     * dispatchService → daemon claims → chatResolver awaits done.
     */
    send: (input: ChatSendInput) =>
      fetchJson<ChatTurnResponse>("/chat", { method: "POST", body: input }),
    /**
     * Conversation history, oldest first.
     *   - no `conversationId` → most recent conversation chain
     *   - `conversationId` set → that specific chain (full `sess_xxx` head id)
     */
    history: (opts: ReadOptions & { conversationId?: string } = {}) =>
      fetchJson<ChatHistoryResponse>("/chat", {
        signal: opts.signal,
        ...(opts.conversationId ? { query: { c: opts.conversationId } } : {}),
      }),
    /** List recent conversations (chains) for the caller's primary agent. */
    conversations: (opts: ReadOptions = {}) =>
      fetchJson<ChatConversationsResponse>("/chat/conversations", {
        signal: opts.signal,
      }),
  },
  activity: {
    /** Recent sessions across the caller's agent tree. Used by the live chat rail. */
    list: (opts: ReadOptions & { limit?: number } = {}) =>
      fetchJson<ActivityEntry[]>("/activity", {
        signal: opts.signal,
        ...(opts.limit ? { query: { limit: opts.limit } } : {}),
      }),
  },
  inbox: {
    /** Items the caller owes a decision on (review/blocked tasks + escalations). */
    list: (opts: ReadOptions & { limit?: number } = {}) =>
      fetchJson<InboxItem[]>("/inbox", {
        signal: opts.signal,
        ...(opts.limit ? { query: { limit: opts.limit } } : {}),
      }),
  },
  workProducts: {
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<WorkProductDetail>(`/work-product/${encodeURIComponent(id)}`, {
        signal: opts.signal,
      }),
  },
  signup: {
    /**
     * Self-serve signup. Mints a person + their primary team agent +
     * a fresh bv_u_ key. Unauthenticated. Idempotent on email — if a
     * person with that email already exists, returns their existing key.
     */
    create: (input: SignupInput) =>
      fetchJson<SignupResponse>("/signup", { method: "POST", body: input }),
  },
  rooms: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<{ ok: true; rooms: Room[] }>("/room", { signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<RoomDetail>(`/room/${encodeURIComponent(id)}`, { signal: opts.signal }),
    create: (input: { name: string }) =>
      fetchJson<{ ok: true; room: Room }>("/room", { method: "POST", body: input }),
    invite: (id: string, input: { email: string }) =>
      fetchJson<{
        ok: true;
        invited: { person_id: string; name: string; email: string | null };
      }>(`/room/${encodeURIComponent(id)}/invite`, { method: "POST", body: input }),
    /** Self-join — caller adds themselves + their team agent. */
    join: (id: string) =>
      fetchJson<{ ok: true; room: Room }>(`/room/${encodeURIComponent(id)}/join`, {
        method: "POST",
      }),
    sendMessage: (id: string, input: { content: string }) =>
      fetchJson<{
        ok: true;
        message: RoomMessage;
        invoked_agents: { id: string; name: string }[];
        invoked_reason: "mention" | "name" | "team-default" | "none";
      }>(`/room/${encodeURIComponent(id)}/message`, { method: "POST", body: input }),
  },
  runtimes: {
    /** List the caller's daemons + nested runtimes (Settings → Runtimes panel). */
    list: (opts: ReadOptions = {}) =>
      fetchJson<RuntimesListResponse>("/runtimes", { signal: opts.signal }),
    /** Revoke a daemon by id; idempotent. Cascades to all of its runtimes. */
    revokeDaemon: (daemonId: string) =>
      fetchJson<RevokeDaemonResponse>(
        `/runtimes/${encodeURIComponent(daemonId)}/revoke`,
        { method: "POST", body: {} },
      ),
  },
  me: {
    /** Identity + onboarding state for the welcome flow. */
    self: (opts: ReadOptions = {}) =>
      fetchJson<MeResponse>("/me", { signal: opts.signal }),
    completeOnboarding: () =>
      fetchJson<{ ok: true; onboarding_completed_at: string | null }>(
        "/me/onboarding/complete",
        { method: "POST" },
      ),
    health: (opts: ReadOptions = {}) =>
      fetchJson<HealthResponse>("/health/runtime", { signal: opts.signal }),
  },
  escalations: {
    resolve: (id: string, input: EscalationResolveInput) =>
      fetchJson<{
        ok: true;
        escalation: { id: string; status: string; resolution_proposal: unknown; resolution_notes: string | null };
        a_task_id: string;
        b_task_id: string;
        note: string;
      }>(`/escalation/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: input,
      }),
  },
} as const;

export type Api = typeof api;
