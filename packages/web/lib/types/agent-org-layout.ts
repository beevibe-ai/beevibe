import type { HierarchyLevel } from "@beevibe/core";

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

export interface OrgEdge {
  d: string;
}
