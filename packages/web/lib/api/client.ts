import { fetchJson } from "./http";
import type {
  TaskDetail,
  AgentDetail,
  DashboardSummary,
  MeshOverview,
  ThreadsOverview,
  ThreadDetail,
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

export type ApproveAction = "approve" | "reject" | "revise";

export interface ApproveTaskInput {
  action: ApproveAction;
  result_summary?: string;
}

export interface CancelTaskInput {
  force?: boolean;
  reason?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignee_id?: string;
  parent_task_id?: string;
}

export const api = {
  tasks: {
    list: (filter: TaskListFilter = {}, opts: ReadOptions = {}) =>
      fetchJson<TaskListItem[]>("/api/tasks", { query: { ...filter }, signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, { signal: opts.signal }),
    approve: (id: string, input: ApproveTaskInput) =>
      fetchJson<Task>(`/api/tasks/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: input,
      }),
    cancel: (id: string, input: CancelTaskInput = {}) =>
      fetchJson<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: input,
      }),
    create: (input: CreateTaskInput) =>
      fetchJson<Task>("/api/tasks", { method: "POST", body: input }),
  },
  agents: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<AgentDisplay[]>("/api/agents", { signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`, { signal: opts.signal }),
  },
  sessions: {
    get: (shortId: string, opts: ReadOptions = {}) =>
      fetchJson<SessionDisplay>(`/api/sessions/${encodeURIComponent(shortId)}`, {
        signal: opts.signal,
      }),
    cancel: (shortId: string) =>
      fetchJson<void>(`/api/sessions/${encodeURIComponent(shortId)}/cancel`, { method: "POST" }),
  },
  memory: {
    listFacts: (filter: { scope?: MemoryScope } = {}, opts: ReadOptions = {}) =>
      fetchJson<MemoryFactDisplay[]>("/api/memory/facts", {
        query: { ...filter },
        signal: opts.signal,
      }),
  },
  promotions: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<PromotionEvent[]>("/api/promotions", { signal: opts.signal }),
  },
  mesh: {
    overview: (filter: { since?: string } = {}, opts: ReadOptions = {}) =>
      fetchJson<MeshOverview>("/api/mesh", { query: { ...filter }, signal: opts.signal }),
  },
  threads: {
    list: (opts: ReadOptions = {}) =>
      fetchJson<ThreadsOverview>("/api/threads", { signal: opts.signal }),
    get: (id: string, opts: ReadOptions = {}) =>
      fetchJson<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`, { signal: opts.signal }),
  },
  dashboard: {
    summary: (opts: ReadOptions = {}) =>
      fetchJson<DashboardSummary>("/api/dashboard", { signal: opts.signal }),
  },
} as const;

export type Api = typeof api;
