import type { Agent, HierarchyLevel } from "@beevibe/core";

export interface WeeklyChange {
  label: string;
  tone: "done" | "muted";
}

export interface AgentDisplay
  extends Pick<
    Agent,
    "id" | "name" | "owner_id" | "parent_agent_id" | "hierarchy_level" | "created_at" | "updated_at"
  > {
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
