import type { TaskListFilter } from "@/lib/api/client";
import type { MemoryScope } from "@beevibe/core";
import type { MeshWindow } from "@/lib/types/mesh";

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
    conversation: (shortId: string) => ["sessions", "conversation", shortId] as const,
  },
  memory: {
    all: ["memory"] as const,
    facts: (filter: { scope?: MemoryScope }) => ["memory", "facts", filter] as const,
    counts: () => ["memory", "counts"] as const,
    activity: (params: { weeks?: number; since?: string }) =>
      ["memory", "activity", params] as const,
  },
  promotions: {
    all: ["promotions"] as const,
    list: () => ["promotions", "list"] as const,
  },
  mesh: {
    all: ["mesh"] as const,
    overview: (filter: { window?: MeshWindow }) => ["mesh", "overview", filter] as const,
  },
  dashboard: {
    all: ["dashboard"] as const,
    summary: () => ["dashboard", "summary"] as const,
  },
  me: {
    all: ["me"] as const,
    self: () => ["me", "self"] as const,
  },
  inbox: {
    all: ["inbox"] as const,
    list: () => ["inbox", "list"] as const,
  },
  escalations: {
    all: ["escalations"] as const,
    detail: (id: string) => ["escalations", "detail", id] as const,
  },
  negotiations: {
    all: ["negotiations"] as const,
    detail: (id: string) => ["negotiations", "detail", id] as const,
  },
  agentNetwork: {
    all: ["agent-network"] as const,
    self: () => ["agent-network", "self"] as const,
  },
  workProducts: {
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
    /** Per-conversation history. `undefined` = the most recent conversation. */
    history: (conversationId?: string) =>
      ["chat", "history", conversationId ?? "<latest>"] as const,
    /** Prefix that matches every per-conversation history slot at once. */
    historyAll: ["chat", "history"] as const,
    conversations: () => ["chat", "conversations"] as const,
  },
} as const;
