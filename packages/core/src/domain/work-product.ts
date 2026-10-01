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

/**
 * One work product as the detail endpoint serves it: the row plus the task
 * and agent labels the page renders, with `created_at` / `updated_at` as
 * the ISO strings JSON carries rather than `Date`s.
 *
 * Declared here because it was declared twice — as `WorkProductDetail` in
 * `packages/api/src/views/work-product.ts` and again in
 * `packages/web/lib/api/client.ts`, which had no way to import the api's
 * copy. The web copy had to inline the nine-member `WorkProductType` union
 * by hand, which is the drift this fixes: adding a tenth kind of
 * deliverable would typecheck on the server and on the client's own list
 * views, while the detail page silently rejected it.
 */
export interface WorkProductDetail {
  id: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  agent_id: string;
  agent_label: string;
  type: WorkProductType;
  title: string;
  summary?: string;
  url?: string;
  provider?: string;
  external_id?: string;
  /**
   * Full deliverable content. Sourced from `work_product.body` when set;
   * otherwise falls back to reading a `file://` URL from disk. Truncated
   * to 256 KB.
   */
  body?: string;
  /** True when `url` is file:// — UI uses this to suppress an unclickable link. */
  url_is_local: boolean;
  created_at: string;
  updated_at: string;
}
