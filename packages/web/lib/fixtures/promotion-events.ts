import type { MemoryScope, FactType } from "@beevibe/core";

export interface PromotionEvent {
  id: string;
  fact_id: string;
  fact_type: FactType;
  fact_content: string;
  from_scope: MemoryScope | null;
  to_scope: MemoryScope;
  origin_agent_id: string;
  origin_agent_label: string;
  promoter_reason: string;
  source_session_ids: string[];
  source_session_extra?: number;
  created_at: Date;
  rejected?: boolean;
}

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

export const fixturePromotions: PromotionEvent[] = [
  {
    id: "prm_001",
    fact_id: "fct_8c4b2af19e",
    fact_type: "decision",
    fact_content:
      "Postgres NOTIFY payload is capped at 8KB. Keep payloads to id, status, and timestamps; clients refetch full rows via HTTP after the event.",
    from_scope: "ic",
    to_scope: "team",
    origin_agent_id: "agt_ic1",
    origin_agent_label: "ic-agent-1",
    promoter_reason:
      "Observation surfaced independently in 3 sessions across 2 different agents (ic-agent-1, ic-agent-2). The constraint is a Postgres-level fact, not domain-specific to auth or to any single agent's work — it generalizes across the team's infrastructure work. Promote to team.",
    source_session_ids: ["sess_3a8c", "sess_5d12", "sess_9e7b"],
    created_at: hoursAgo(2),
  },
  {
    id: "prm_002",
    fact_id: "fct_2e9a4f8c3d",
    fact_type: "pattern",
    fact_content:
      "All inter-agent communication flows through the task queue and mesh tools, not direct calls. Async dispatch via task assignment + synchronous mesh ask are the only two primitives — no out-of-band agent-to-agent RPC.",
    from_scope: "team",
    to_scope: "org",
    origin_agent_id: "agt_team_alpha",
    origin_agent_label: "team-alpha",
    promoter_reason:
      "This is a foundational architectural invariant of the runtime, not a team-specific pattern. team-data has independently arrived at the same constraint in their work. Cross-team applicability and architectural-tier importance both warrant org scope.",
    source_session_ids: ["sess_1f4a", "sess_8b2c", "sess_4d9e", "sess_7c1a"],
    source_session_extra: 4,
    created_at: hoursAgo(11),
  },
  {
    id: "prm_003",
    fact_id: "fct_6d3b8e2a91",
    fact_type: "pattern",
    fact_content:
      "When a task is rejected back to revision, the agent re-uses the same prior_session_id chain — context flows forward, not backward. Reviewer notes attach to the new session's intent, not to the rejected session.",
    from_scope: "ic",
    to_scope: "team",
    origin_agent_id: "agt_ic2",
    origin_agent_label: "ic-agent-2",
    promoter_reason:
      "Pattern about the revision flow that any IC agent in team-alpha could plausibly hit. Generalizes across the team's task work; not specific to one agent's domain. Promote to team.",
    source_session_ids: ["sess_2a9f", "sess_6e3b"],
    created_at: daysAgo(1),
  },
  {
    id: "prm_004_rejected",
    fact_id: "fct_5b9c2e73d1",
    fact_type: "belief",
    fact_content:
      "pgvector cosine similarity outperforms L2 distance for memory_fact retrieval — embeddings cluster better in angular space when content lengths vary widely.",
    from_scope: "ic",
    to_scope: "ic",
    origin_agent_id: "agt_db",
    origin_agent_label: "db-agent",
    promoter_reason:
      "Only db-agent has applied this in production retrieval contexts. No other IC has independently observed it. The claim could be true but lacks the cross-session corroboration team scope requires. Keep narrow until corroborating evidence appears.",
    source_session_ids: ["sess_8c2a"],
    created_at: daysAgo(2),
    rejected: true,
  },
];
