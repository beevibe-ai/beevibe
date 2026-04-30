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

export interface FactCounts {
  total: number;
  ic: number;
  team: number;
  org: number;
}
