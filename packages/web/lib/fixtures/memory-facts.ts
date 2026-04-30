import type { FactType, MemoryScope } from "@beevibe/core";
import type { RichText } from "@/components/rich-text";

export type MergeOrigin = "merged" | "promoted" | "single";

export interface MemoryFactDisplay {
  id: string;
  content: RichText;
  fact_type: FactType;
  scope: MemoryScope;
  agent_id: string;
  agent_label: string;
  source_session_count: number;
  created_at: Date;
  merge_origin?: MergeOrigin;
  promotion_origin_scope?: MemoryScope;
}

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86_400_000);
const weeksAgo = (w: number) => new Date(now - w * 7 * 86_400_000);

export const fixtureFacts: MemoryFactDisplay[] = [
  {
    id: "fct_3d9f7c10a4",
    content: [
      "Claude Code spawns subprocesses; the executor must reap them with ",
      { mono: "process_group_id" },
      ", not just ",
      { mono: "process_pid" },
      ", or orphaned children accumulate over long runs.",
    ],
    fact_type: "gotcha",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 4,
    created_at: daysAgo(3),
    merge_origin: "merged",
  },
  {
    id: "fct_ic1_mcp",
    content: [
      "When binding bv_u_ to MCP, the server-assigned ",
      { mono: "Mcp-Session-Id" },
      " must be cached in-memory keyed to the session row id — Claude Code CLI auto-echoes the header on every subsequent request per spec 2025-11-25.",
    ],
    fact_type: "decision",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 1,
    created_at: daysAgo(2),
    merge_origin: "single",
  },
  {
    id: "fct_ic1_notify",
    content:
      "Postgres NOTIFY payload is capped at 8KB. Keep payloads to id, status, and timestamps; clients refetch full rows via HTTP after the event.",
    fact_type: "decision",
    scope: "team",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 3,
    created_at: daysAgo(4),
    merge_origin: "promoted",
    promotion_origin_scope: "ic",
  },
  {
    id: "fct_ic1_oauth21",
    content:
      "OAuth 2.1 strict mode rejects implicit grant entirely. For Claude Code CLI integration, use authorization-code-with-PKCE; bv_ keys exchange for short-lived bearer tokens via the token endpoint.",
    fact_type: "pattern",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 2,
    created_at: daysAgo(5),
    merge_origin: "merged",
  },
  {
    id: "fct_ic1_drift",
    content: [
      "When the OAuth provider config drift (e.g., redirect URI changed in their dashboard, not ours), the failure surfaces as a 400 from ",
      { mono: "/token" },
      ", not a redirect failure. Log the upstream response body, not just status.",
    ],
    fact_type: "gotcha",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 1,
    created_at: daysAgo(6),
    merge_origin: "single",
  },
  {
    id: "fct_ic1_argon",
    content:
      "Prefer Argon2id over bcrypt for new password hashes — Argon2 has tunable memory cost that resists GPU attack better; bcrypt's 72-byte input limit is a footgun for long passphrases.",
    fact_type: "preference",
    scope: "ic",
    agent_id: "agt_ic1",
    agent_label: "ic-agent-1",
    source_session_count: 1,
    created_at: weeksAgo(1),
    merge_origin: "single",
  },
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
