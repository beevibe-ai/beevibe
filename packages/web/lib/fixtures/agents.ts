import type { Agent, HierarchyLevel } from "@beevibe/core";

export interface WeeklyChange {
  label: string;
  tone: "done" | "muted";
}

export interface AgentDisplay extends Pick<Agent, "id" | "name" | "owner_id" | "parent_agent_id" | "hierarchy_level" | "created_at" | "updated_at"> {
  display_name: string;
  hierarchy: HierarchyLevel;
  sessions_count?: number;
  facts_learned?: number;
  merge_events?: number;
  specialization?: string;
  weekly_change?: WeeklyChange;
  themes?: string[];
  runtime?: string;
  review_policy?: string;
}

export interface RecentSession {
  short_id?: string;
  title: string;
  status: "running" | "succeeded" | "review";
  age: string;
}

export interface OutgoingMeshHint {
  target: string;
  intent: string;
  age: string;
}

const epoch = new Date("2026-04-01T00:00:00Z");

function mk(
  id: string,
  name: string,
  hier: HierarchyLevel,
  parent: string | null,
  metrics: { sessions: number; facts: number; merges: number },
  extra: { specialization?: string; weekly_change?: WeeklyChange } = {},
): AgentDisplay {
  return {
    id,
    name,
    display_name: name,
    hierarchy: hier,
    hierarchy_level: hier,
    owner_id: "per_weijia",
    parent_agent_id: parent ?? undefined,
    sessions_count: metrics.sessions,
    facts_learned: metrics.facts,
    merge_events: metrics.merges,
    created_at: epoch,
    updated_at: epoch,
    ...extra,
  };
}

export const fixtureAgents: AgentDisplay[] = [
  mk("agt_root_org", "root-org", "org", null, { sessions: 2, facts: 4, merges: 1 }, {
    specialization: "strategy",
    weekly_change: { label: "—", tone: "muted" },
  }),
  mk("agt_team_alpha", "team-alpha", "team", "agt_root_org", { sessions: 8, facts: 9, merges: 2 }, {
    specialization: "coordinator",
    weekly_change: { label: "+1", tone: "muted" },
  }),
  mk("agt_team_data", "team-data", "team", "agt_root_org", { sessions: 4, facts: 3, merges: 0 }, {
    specialization: "coordinator",
    weekly_change: { label: "—", tone: "muted" },
  }),
  mk("agt_ic1", "ic-agent-1", "ic", "agt_team_alpha", { sessions: 47, facts: 23, merges: 8 }, {
    specialization: "auth · OAuth",
    weekly_change: { label: "+3 this wk", tone: "done" },
  }),
  mk("agt_ic2", "ic-agent-2", "ic", "agt_team_alpha", { sessions: 31, facts: 14, merges: 4 }, {
    specialization: "infra · logging",
    weekly_change: { label: "+1", tone: "muted" },
  }),
  mk("agt_ic3", "ic-agent-3", "ic", "agt_team_alpha", { sessions: 23, facts: 11, merges: 2 }, {
    specialization: "infra · refactor",
    weekly_change: { label: "+2", tone: "done" },
  }),
  mk("agt_db", "db-agent", "ic", "agt_team_data", { sessions: 19, facts: 17, merges: 5 }, {
    specialization: "data · migrations",
    weekly_change: { label: "—", tone: "muted" },
  }),
];

const ic1 = fixtureAgents.find((a) => a.id === "agt_ic1");
if (ic1) {
  ic1.themes = [
    "OAuth 2.1",
    "JWT",
    "session storage",
    "PKCE",
    "bv_ keys",
    "MCP auth",
    "password hashing",
    "CSRF",
  ];
  ic1.runtime = "claude-opus-4-7";
  ic1.review_policy = "require_human";
}

export const fixtureSpecializationOrder: string[] = [
  "agt_ic1",
  "agt_ic2",
  "agt_ic3",
  "agt_db",
  "agt_team_alpha",
  "agt_team_data",
  "agt_root_org",
];

export const fixtureFleetCounts = {
  org: 1,
  team: 2,
  ic: 4,
  total: 7,
  active: 4,
};

export const fixtureAgentRecentSessions: Record<string, RecentSession[]> = {
  agt_ic1: [
    { short_id: "sess_3a8c", title: "running OAuth flow integration", status: "running", age: "2m" },
    { title: "add MCP session-id round-trip", status: "succeeded", age: "2h" },
    { title: "audit token rotation policy", status: "review", age: "1d" },
    { title: "migrate password hashing to argon2id", status: "succeeded", age: "3d" },
  ],
};

export const fixtureAgentMeshHints: Record<string, OutgoingMeshHint[]> = {
  agt_ic1: [
    {
      target: "db-agent",
      intent: "Asked about refresh-token storage schema and lock semantics.",
      age: "4s ago",
    },
    {
      target: "team-alpha",
      intent: "Reported OAuth provider config drift; awaiting human decision.",
      age: "3h ago",
    },
  ],
};
