import type { TaskListFilter } from "@/lib/api/client";
import type { MemoryScope } from "@beevibe/core";

export const queryKeys = {
  tasks: {
    all: ["tasks"] as const,
    list: (filter: TaskListFilter) => ["tasks", "list", filter] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
  },
  agents: {
    all: ["agents"] as const,
    list: () => ["agents", "list"] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    detail: (shortId: string) => ["sessions", "detail", shortId] as const,
  },
  memory: {
    all: ["memory"] as const,
    facts: (filter: { scope?: MemoryScope }) => ["memory", "facts", filter] as const,
  },
  promotions: {
    all: ["promotions"] as const,
    list: () => ["promotions", "list"] as const,
  },
  mesh: {
    all: ["mesh"] as const,
    overview: (filter: { since?: string }) => ["mesh", "overview", filter] as const,
  },
  threads: {
    all: ["threads"] as const,
    list: () => ["threads", "list"] as const,
    detail: (id: string) => ["threads", "detail", id] as const,
  },
  dashboard: {
    all: ["dashboard"] as const,
    summary: () => ["dashboard", "summary"] as const,
  },
} as const;
