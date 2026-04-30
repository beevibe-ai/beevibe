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
import type { MemoryScope } from "@beevibe/core";
import type { Lifecycle } from "@/lib/tasks-grouping";

export type TaskView = "all" | "mine" | "sprint" | "timeline";

export interface TaskListFilter {
  lifecycle?: Lifecycle;
  assignee_id?: string;
  view?: TaskView;
}

export const api = {
  tasks: {
    list: (filter: TaskListFilter = {}) =>
      fetchJson<TaskListItem[]>("/api/tasks", { query: { ...filter } }),
    get: (id: string) => fetchJson<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  },
  agents: {
    list: () => fetchJson<AgentDisplay[]>("/api/agents"),
    get: (id: string) => fetchJson<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`),
  },
  sessions: {
    get: (shortId: string) =>
      fetchJson<SessionDisplay>(`/api/sessions/${encodeURIComponent(shortId)}`),
  },
  memory: {
    listFacts: (filter: { scope?: MemoryScope } = {}) =>
      fetchJson<MemoryFactDisplay[]>("/api/memory/facts", { query: { ...filter } }),
  },
  promotions: {
    list: () => fetchJson<PromotionEvent[]>("/api/promotions"),
  },
  mesh: {
    overview: (filter: { since?: string } = {}) =>
      fetchJson<MeshOverview>("/api/mesh", { query: { ...filter } }),
  },
  threads: {
    list: () => fetchJson<ThreadsOverview>("/api/threads"),
    get: (id: string) => fetchJson<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`),
  },
  dashboard: {
    summary: () => fetchJson<DashboardSummary>("/api/dashboard"),
  },
} as const;

export type Api = typeof api;
