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
import type { Task, MemoryScope, TaskPriority } from "@beevibe/core";
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
  suggested_actions?: string[];
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  session_id?: string;
  view_refs?: string[];
  open_view?: { path: string; label?: string };
  suggested_actions?: string[];
}

export interface ChatHistoryResponse {
  ok: true;
  agent: { id: string; name: string; hierarchy: "ic" | "team" | "org" } | null;
  messages: ChatHistoryMessage[];
  /** The most recent session id, used to chain `prior_session_id` on the next turn. */
  prior_session_id: string | null;
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
     * AgentSession.run synchronously; expect a 5–30s wait for the response.
     */
    send: (input: ChatSendInput) =>
      fetchJson<ChatTurnResponse>("/chat", { method: "POST", body: input }),
    /** Recent conversation, oldest first. Used to rehydrate after a reload. */
    history: (opts: ReadOptions = {}) =>
      fetchJson<ChatHistoryResponse>("/chat", { signal: opts.signal }),
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
