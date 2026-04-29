import type { FactType, MemoryScope } from "@beevibe/core";

export interface MemoryFactDisplay {
  id: string;
  content: string;
  fact_type: FactType;
  scope: MemoryScope;
  agent_id: string;
  agent_label: string;
  source_session_count: number;
  created_at: Date;
}

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86_400_000);
const weeksAgo = (w: number) => new Date(now - w * 7 * 86_400_000);

export const fixtureFacts: MemoryFactDisplay[] = [
  {
    id: "fct_8c4b2af19e",
    content:
      "Postgres NOTIFY payload is capped at 8KB. Keep payloads to id, status, and timestamps; clients refetch full rows via HTTP after the event.",
    fact_type: "decision",
    scope: "team",
    agent_id: "agt_team_alpha",
    agent_label: "team-alpha",
    source_session_count: 3,
    created_at: daysAgo(2),
  },
  {
    id: "fct_3d9f7c10a4",
    content:
      "Claude Code spawns subprocesses; the executor must reap them with process_group_id, not just process_pid, or orphaned children accumulate over long runs.",
    fact_type: "gotcha",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 2,
    created_at: daysAgo(3),
  },
  {
    id: "fct_2e9a4f8c3d",
    content:
      "All inter-agent communication flows through the task queue, not direct calls. Async dispatch via task assignment is the only mesh primitive — no synchronous agent-to-agent RPC.",
    fact_type: "pattern",
    scope: "org",
    agent_id: "agt_root_org",
    agent_label: "root-org",
    source_session_count: 8,
    created_at: weeksAgo(1),
  },
  {
    id: "fct_4a8b1d62c0",
    content:
      "For dense list views, prefer Inter over IBM Plex Sans — better metrics at 12–14px and matches the operator-tool aesthetic the rest of our stack uses.",
    fact_type: "preference",
    scope: "team",
    agent_id: "agt_team_alpha",
    agent_label: "team-alpha",
    source_session_count: 1,
    created_at: daysAgo(4),
  },
  {
    id: "fct_5b9c2e73d1",
    content:
      "pgvector cosine similarity outperforms L2 distance for memory_fact retrieval — embeddings cluster better in angular space when content lengths vary widely.",
    fact_type: "belief",
    scope: "ic",
    agent_id: "agt_db",
    agent_label: "db-agent",
    source_session_count: 2,
    created_at: daysAgo(5),
  },
  {
    id: "fct_6d3b8e2a91",
    content:
      "When a task is rejected back to revision, the agent re-uses the same prior_session_id chain — context flows forward, not backward. Reviewer notes attach to the new session's intent, not to the rejected session.",
    fact_type: "pattern",
    scope: "team",
    agent_id: "agt_ic2",
    agent_label: "ic-agent-2",
    source_session_count: 2,
    created_at: daysAgo(1),
  },
  {
    id: "fct_7e4c9f3b82",
    content:
      "Intent strings >120 chars compress poorly under the briefing token budget; keep intent lines under one sentence. Detail belongs in description, not intent.",
    fact_type: "preference",
    scope: "team",
    agent_id: "agt_team_alpha",
    agent_label: "team-alpha",
    source_session_count: 4,
    created_at: daysAgo(6),
  },
  {
    id: "fct_8f5d0a4c93",
    content:
      "Tailwind prefers-color-scheme with class-based dark mode requires a small inline script to set the .dark class before paint, otherwise flicker happens between SSR and client hydration.",
    fact_type: "gotcha",
    scope: "ic",
    agent_id: "agt_ic3",
    agent_label: "ic-agent-3",
    source_session_count: 1,
    created_at: weeksAgo(2),
  },
];

export const fixtureFactCounts = {
  total: 47,
  ic: 23,
  team: 18,
  org: 6,
};
