import type { WorkProduct, WorkProductListItem } from "../domain/work-product.js";

export type NewWorkProduct = Omit<WorkProduct, "created_at" | "updated_at">;

/**
 * Mutable subset for `update_work_product`. Identity fields (`id`, `task_id`,
 * `agent_id`, `type`, `title`) are immutable — the agent-facing semantics
 * say "amend this deliverable", not "replace its identity". `created_at` and
 * `updated_at` are managed by the adapter.
 */
export type WorkProductPatch = Partial<
  Pick<WorkProduct, "summary" | "body" | "url" | "provider" | "external_id" | "metadata">
>;

export interface WorkProductRepository {
  findById(id: string): Promise<WorkProduct | undefined>;

  listByTask(taskId: string): Promise<WorkProductListItem[]>;

  listByAgent(agentId: string): Promise<WorkProductListItem[]>;

  create(input: NewWorkProduct): Promise<WorkProduct>;

  /**
   * Amend mutable fields. Bumps `updated_at = NOW()`. Throws if the row
   * doesn't exist. The set of mutable fields is intentionally narrow — see
   * `WorkProductPatch`.
   */
  update(id: string, patch: WorkProductPatch): Promise<WorkProduct>;

  delete(id: string): Promise<void>;
}
