import type { MemoryPromotionEvent } from "../domain/memory.js";

export type NewMemoryPromotionEvent = Omit<MemoryPromotionEvent, "created_at">;

export interface MemoryPromotionEventRepository {
  /** Append a single event. Called by MemoryAgent for every FactPromoter decision. */
  create(input: NewMemoryPromotionEvent): Promise<MemoryPromotionEvent>;

  /**
   * List events scoped to an owner (joined through `memory_fact.agent_id →
   * agent.owner_id`). Most-recent first; capped by `limit`. Used by the
   * Promotions page view; never exposed to agents.
   */
  listByOwner(ownerId: string, limit: number): Promise<MemoryPromotionEvent[]>;

  /** Lookup by id. Mostly for tests + diagnostics. */
  findById(id: string): Promise<MemoryPromotionEvent | undefined>;
}
