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
    counts: () => ["memory", "counts"] as const,
  },
  promotions: {
    all: ["promotions"] as const,
    list: () => ["promotions", "list"] as const,
  },
  mesh: {
    all: ["mesh"] as const,
    overview: (filter: { since?: string }) => ["mesh", "overview", filter] as const,
  },
  dashboard: {
    all: ["dashboard"] as const,
    summary: () => ["dashboard", "summary"] as const,
  },
  me: {
    all: ["me"] as const,
    self: () => ["me", "self"] as const,
    health: () => ["me", "health"] as const,
  },
  activity: {
    all: ["activity"] as const,
    feed: () => ["activity", "feed"] as const,
  },
  inbox: {
    all: ["inbox"] as const,
    list: () => ["inbox", "list"] as const,
  },
  agentNetwork: {
    all: ["agent-network"] as const,
    self: () => ["agent-network", "self"] as const,
  },
  workProducts: {
    all: ["work-products"] as const,
    detail: (id: string) => ["work-products", "detail", id] as const,
  },
  rooms: {
    all: ["rooms"] as const,
    list: () => ["rooms", "list"] as const,
    detail: (id: string) => ["rooms", "detail", id] as const,
  },
  runtimes: {
    all: ["runtimes"] as const,
    list: () => ["runtimes", "list"] as const,
  },
  chat: {
    all: ["chat"] as const,
    /** Per-conversation history. `undefined` = the most recent conversation. */
    history: (conversationId?: string) =>
      ["chat", "history", conversationId ?? "<latest>"] as const,
    /** Prefix that matches every per-conversation history slot at once. */
    historyAll: ["chat", "history"] as const,
    conversations: () => ["chat", "conversations"] as const,
  },
} as const;
