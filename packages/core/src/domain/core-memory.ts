import type { HierarchyLevel } from "./agent.js";

export interface CoreMemoryBlock {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_limit: number;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export const TOTAL_BLOCK_CHAR_LIMIT = 50_000;

export const ROUTING_BLOCKS: Record<HierarchyLevel, readonly string[]> = {
  ic: ["persona", "domain"],
  team: ["persona", "team_members"],
  org: ["persona", "teams"],
};

export interface BlockTemplate {
  block_name: string;
  char_limit: number;
  is_system: boolean;
  initial_content: string;
}

export const DEFAULT_BLOCK_TEMPLATES: Record<HierarchyLevel, readonly BlockTemplate[]> = {
  ic: [
    { block_name: "persona", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "domain", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "active_context", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "constraints", char_limit: 2000, is_system: true, initial_content: "" },
  ],
  team: [
    { block_name: "persona", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "team_members", char_limit: 3000, is_system: true, initial_content: "" },
    { block_name: "active_work", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "patterns", char_limit: 2000, is_system: true, initial_content: "" },
  ],
  org: [
    { block_name: "persona", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "teams", char_limit: 3000, is_system: true, initial_content: "" },
    { block_name: "strategy", char_limit: 2000, is_system: true, initial_content: "" },
    { block_name: "decisions", char_limit: 2000, is_system: true, initial_content: "" },
  ],
};
