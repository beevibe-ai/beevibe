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
  /**
   * Full deliverable content — the extracted tables, parsed analysis,
   * complete document, etc. `summary` describes what was produced;
   * `body` IS what was produced. Optional because some work products
   * (a PR, a commit) are pointers to external systems and have nothing
   * to inline; in those cases set `url` instead.
   */
  body?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  /** Bumped on every UPDATE via the update_work_product MCP tool. */
  updated_at: Date;
}

/**
 * Body-less projection returned by list endpoints. Bodies can be huge
 * (extracted tables, full documents), so listing pushes the size into
 * SQL via `octet_length(body)` rather than shipping every byte. Callers
 * who want the content read it via `findById`.
 */
export type WorkProductListItem = Omit<WorkProduct, "body"> & {
  body_bytes: number;
};
