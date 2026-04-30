import type { Agent, HierarchyLevel } from "@beevibe/core";

export interface AgentDisplay extends Pick<Agent, "id" | "name" | "owner_id" | "parent_agent_id" | "hierarchy_level" | "created_at" | "updated_at"> {
  display_name: string;
  hierarchy: HierarchyLevel;
  sessions_count?: number;
  facts_learned?: number;
  merge_events?: number;
}

const epoch = new Date("2026-04-01T00:00:00Z");

function mk(id: string, name: string, hier: HierarchyLevel, parent: string | null, metrics?: { sessions: number; facts: number; merges: number }): AgentDisplay {
  return {
    id,
    name,
    display_name: name,
    hierarchy: hier,
    hierarchy_level: hier,
    owner_id: "per_weijia",
    parent_agent_id: parent ?? undefined,
    sessions_count: metrics?.sessions,
    facts_learned: metrics?.facts,
    merge_events: metrics?.merges,
    created_at: epoch,
    updated_at: epoch,
  };
}

export const fixtureAgents: AgentDisplay[] = [
  mk("agt_root_org", "root-org", "org", null, { sessions: 142, facts: 6, merges: 3 }),
  mk("agt_team_alpha", "team-alpha", "team", "agt_root_org", { sessions: 67, facts: 18, merges: 7 }),
  mk("agt_team_data", "team-data", "team", "agt_root_org", { sessions: 45, facts: 12, merges: 4 }),
  mk("agt_ic1", "ic-agent-1", "ic", "agt_team_alpha", { sessions: 28, facts: 9, merges: 2 }),
  mk("agt_ic2", "ic-agent-2", "ic", "agt_team_alpha", { sessions: 21, facts: 7, merges: 1 }),
  mk("agt_ic3", "ic-agent-3", "ic", "agt_team_alpha", { sessions: 18, facts: 5, merges: 1 }),
  mk("agt_db", "db-agent", "ic", "agt_team_data", { sessions: 24, facts: 8, merges: 2 }),
];

export const fixtureFleetCounts = {
  org: 1,
  team: 2,
  ic: 4,
  total: 7,
};
