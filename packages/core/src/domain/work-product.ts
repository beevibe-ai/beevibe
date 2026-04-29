export type WorkProductType =
  | "pull_request"
  | "branch"
  | "commit"
  | "document"
  | "analysis"
  | "report"
  | "design"
  | "artifact"
  | "preview";

export const WORK_PRODUCT_TYPES: readonly WorkProductType[] = [
  "pull_request",
  "branch",
  "commit",
  "document",
  "analysis",
  "report",
  "design",
  "artifact",
  "preview",
] as const;

export interface WorkProduct {
  id: string;
  task_id: string;
  agent_id: string;
  type: WorkProductType;
  title: string;
  summary?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  /** Bumped on every UPDATE via the update_work_product MCP tool. */
  updated_at: Date;
}
