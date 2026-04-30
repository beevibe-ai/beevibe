import { type HierarchyLevel } from "@beevibe/core";

export interface OrgNode {
  id: string;
  name: string;
  hierarchy: HierarchyLevel;
  initial: string;
  iconName: "building-2" | "users-round" | "key-round" | "database";
  x: number;
  y: number;
  presence: "running" | "idle" | "off";
  meta_line: string;
  footer: string;
  pulse_count?: number;
}

export const ORG_CHART_VIEWBOX = "0 0 1016 580";
export const ORG_CHART_W = 1016;
export const ORG_CHART_H = 580;

export const fixtureOrgNodes: OrgNode[] = [
  {
    id: "agt_root_org",
    name: "root-org",
    hierarchy: "org",
    initial: "O",
    iconName: "building-2",
    x: 408,
    y: 60,
    presence: "idle",
    meta_line: "2 children · idle",
    footer: "last active 5d ago",
  },
  {
    id: "agt_team_alpha",
    name: "team-alpha",
    hierarchy: "team",
    initial: "α",
    iconName: "users-round",
    x: 292,
    y: 240,
    presence: "running",
    meta_line: "3 ICs · 1 running",
    footer: "67 sessions",
    pulse_count: 1,
  },
  {
    id: "agt_team_data",
    name: "team-data",
    hierarchy: "team",
    initial: "δ",
    iconName: "users-round",
    x: 756,
    y: 240,
    presence: "idle",
    meta_line: "1 IC · idle",
    footer: "45 sessions",
  },
  {
    id: "agt_ic1",
    name: "ic-agent-1",
    hierarchy: "ic",
    initial: "1",
    iconName: "key-round",
    x: 60,
    y: 420,
    presence: "running",
    meta_line: "auth · 1 running",
    footer: "47 sessions · 23 facts",
    pulse_count: 1,
  },
  {
    id: "agt_ic2",
    name: "ic-agent-2",
    hierarchy: "ic",
    initial: "2",
    iconName: "key-round",
    x: 292,
    y: 420,
    presence: "idle",
    meta_line: "memory · idle",
    footer: "21 sessions · 7 facts",
  },
  {
    id: "agt_ic3",
    name: "ic-agent-3",
    hierarchy: "ic",
    initial: "3",
    iconName: "key-round",
    x: 524,
    y: 420,
    presence: "idle",
    meta_line: "ui · idle",
    footer: "18 sessions · 5 facts",
  },
  {
    id: "agt_db",
    name: "db-agent",
    hierarchy: "ic",
    initial: "d",
    iconName: "database",
    x: 756,
    y: 420,
    presence: "idle",
    meta_line: "data · idle",
    footer: "24 sessions · 8 facts",
  },
];

export const ORG_EDGES: { d: string }[] = [
  { d: "M 508 160 L 508 200 L 392 200 L 392 240" },
  { d: "M 508 160 L 508 200 L 856 200 L 856 240" },
  { d: "M 392 340 L 392 380 L 160 380 L 160 420" },
  { d: "M 392 340 L 392 420" },
  { d: "M 392 340 L 392 380 L 624 380 L 624 420" },
  { d: "M 856 340 L 856 420" },
];
