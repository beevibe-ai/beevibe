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
