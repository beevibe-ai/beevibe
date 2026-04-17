import type { CoreMemoryBlock } from "../domain/core-memory.js";
import type { HierarchyLevel } from "../domain/agent.js";

export type NewCoreMemoryBlock = Omit<CoreMemoryBlock, "created_at" | "updated_at">;

export interface CoreMemoryBlockRepository {
  findByAgent(agentId: string): Promise<CoreMemoryBlock[]>;

  findOne(agentId: string, blockName: string): Promise<CoreMemoryBlock | undefined>;

  /** Insert or update by (agent_id, block_name) UNIQUE key. */
  upsert(input: NewCoreMemoryBlock): Promise<CoreMemoryBlock>;

  /**
   * Update only the content + updated_at of an existing block.
   * Throws if the block doesn't exist. Enforces char_limit server-side or caller-side.
   */
  updateContent(agentId: string, blockName: string, content: string): Promise<CoreMemoryBlock>;

  delete(agentId: string, blockName: string): Promise<void>;

  /**
   * Initialize the default block set for a new agent of the given hierarchy level.
   * Writes all DEFAULT_BLOCK_TEMPLATES for that level if they don't already exist.
   */
  initDefaults(agentId: string, level: HierarchyLevel): Promise<CoreMemoryBlock[]>;
}
