import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { HierarchyLevel } from "../../domain/agent.js";
import type { CoreMemoryBlockRepository } from "../../ports/core-memory-repo.js";

export type CoreMemoryOperation = "append" | "replace";

export interface CoreMemoryDeps {
  repo: CoreMemoryBlockRepository;
}

/**
 * CoreMemory orchestrates agent-driven block edits. Backing service for the
 * `update_core_memory` MCP tool (wired in M6).
 *
 * - `append` grows the named block with new content (separator-joined),
 *   enforcing the block's char_limit.
 * - `replace` performs a targeted substring swap: the caller supplies an
 *   `old_content` fragment that must exist in the current block, and the
 *   service replaces just that fragment. Mirrors Letta's core_memory_replace.
 *
 * No LLM dependency: this service only reads + writes through the repo.
 */
export class CoreMemory {
  constructor(private deps: CoreMemoryDeps) {}

  async read(agentId: string): Promise<CoreMemoryBlock[]> {
    return this.deps.repo.findByAgent(agentId);
  }

  async initDefaults(agentId: string, level: HierarchyLevel): Promise<CoreMemoryBlock[]> {
    return this.deps.repo.initDefaults(agentId, level);
  }

  async applyUpdate(
    agentId: string,
    blockName: string,
    operation: CoreMemoryOperation,
    content: string,
    oldContent?: string,
  ): Promise<CoreMemoryBlock> {
    const block = await this.deps.repo.findOne(agentId, blockName);
    if (!block) {
      throw new Error(
        `Block "${blockName}" not found for agent ${agentId} — initDefaults first`,
      );
    }

    let nextContent: string;
    if (operation === "append") {
      const separator = block.content.length > 0 ? "\n" : "";
      nextContent = `${block.content}${separator}${content}`;
    } else {
      if (oldContent === undefined || oldContent.length === 0) {
        throw new Error(
          `update_core_memory(replace) requires non-empty old_content for block "${blockName}"`,
        );
      }
      if (!block.content.includes(oldContent)) {
        throw new Error(
          `update_core_memory(replace): old_content not found in block "${blockName}"`,
        );
      }
      nextContent = block.content.replace(oldContent, content);
    }

    if (nextContent.length > block.char_limit) {
      throw new Error(
        `Block "${blockName}" would exceed char_limit ${block.char_limit} ` +
          `(new length ${nextContent.length})`,
      );
    }

    return this.deps.repo.updateContent(agentId, blockName, nextContent);
  }

  /**
   * Owner-driven full-block overwrite. Where `applyUpdate` is the agent's
   * append/replace-substring path, this is the human's "rewrite the whole
   * block" path — used by the agent detail page's Edit affordance. Same
   * char_limit + block-existence guards.
   *
   * Throws {@link BlockNotFoundError} or {@link BlockCharLimitExceededError}
   * so HTTP callers can map to 4xx via `instanceof` (mirrors the
   * TaskNotFoundError / InvalidTaskTransitionError pattern in task-service).
   */
  async setContent(
    agentId: string,
    blockName: string,
    content: string,
  ): Promise<CoreMemoryBlock> {
    const block = await this.deps.repo.findOne(agentId, blockName);
    if (!block) {
      throw new BlockNotFoundError(agentId, blockName);
    }
    if (content.length > block.char_limit) {
      throw new BlockCharLimitExceededError(blockName, block.char_limit, content.length);
    }
    return this.deps.repo.updateContent(agentId, blockName, content);
  }
}

export class BlockNotFoundError extends Error {
  constructor(agentId: string, blockName: string) {
    super(`Block "${blockName}" not found for agent ${agentId} — initDefaults first`);
    this.name = "BlockNotFoundError";
  }
}

export class BlockCharLimitExceededError extends Error {
  constructor(blockName: string, limit: number, attempted: number) {
    super(
      `Block "${blockName}" would exceed char_limit ${limit} (new length ${attempted})`,
    );
    this.name = "BlockCharLimitExceededError";
  }
}
