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

export interface ChatSendInput {
  message: string;
  /** Previous turn's session id — enables `--resume` continuity. */
  prior_session_id?: string;
}

export interface ChatTurnResponse {
  ok: true;
  agent: { id: string; name: string; hierarchy: "ic" | "team" | "org" };
  session_id: string;
  response: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
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
