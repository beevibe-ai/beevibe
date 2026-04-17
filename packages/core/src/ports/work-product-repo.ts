import type { WorkProduct } from "../domain/work-product.js";

export type NewWorkProduct = Omit<WorkProduct, "created_at">;

export interface WorkProductRepository {
  findById(id: string): Promise<WorkProduct | undefined>;

  listByTask(taskId: string): Promise<WorkProduct[]>;

  listByAgent(agentId: string): Promise<WorkProduct[]>;

  create(input: NewWorkProduct): Promise<WorkProduct>;

  delete(id: string): Promise<void>;
}
