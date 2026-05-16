import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { HierarchyLevel } from "../../domain/agent.js";
import type { CoreMemoryBlockRepository } from "../../ports/core-memory-repo.js";

export type CoreMemoryOperation = "append" | "replace";

/** Typed errors so callers can map to status codes without string-matching. */
export class BlockNotFoundError extends Error {
  readonly code = "block_not_found";
  constructor(agentId: string, blockName: string) {
    super(`Block "${blockName}" not found for agent ${agentId} — initDefaults first`);
    this.name = "BlockNotFoundError";
  }
}

export class CharLimitExceededError extends Error {
  readonly code = "char_limit_exceeded";
  constructor(blockName: string, attempted: number, limit: number) {
    super(
      `Block "${blockName}" would exceed char_limit ${limit} (new length ${attempted})`,
    );
    this.name = "CharLimitExceededError";
  }
}

export class InvalidReplaceError extends Error {
  readonly code = "invalid_replace";
  constructor(message: string) {
    super(message);
    this.name = "InvalidReplaceError";
  }
}

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
    const block = await this.loadBlockOrThrow(agentId, blockName);

    let nextContent: string;
    if (operation === "append") {
      const separator = block.content.length > 0 ? "\n" : "";
      nextContent = `${block.content}${separator}${content}`;
    } else {
      if (oldContent === undefined || oldContent.length === 0) {
        throw new InvalidReplaceError(
          `update_core_memory(replace) requires non-empty old_content for block "${blockName}"`,
        );
      }
      if (!block.content.includes(oldContent)) {
        throw new InvalidReplaceError(
          `update_core_memory(replace): old_content not found in block "${blockName}"`,
        );
      }
      nextContent = block.content.replace(oldContent, content);
    }

    this.assertWithinLimit(block, nextContent);
    return this.deps.repo.updateContent(agentId, blockName, nextContent);
  }

  /**
   * Replace a block's entire content. Used by the human-facing core
   * memory editor (POST `/agent/:id/core-memory/:block_name`) — agents
   * use `applyUpdate` with append/replace operations so their MCP
   * surface stays narrow + auditable. The human path doesn't need the
   * substring-replace contract; a textarea edit is a full-content swap.
   */
  async replaceAll(
    agentId: string,
    blockName: string,
    content: string,
  ): Promise<CoreMemoryBlock> {
    const block = await this.loadBlockOrThrow(agentId, blockName);
    this.assertWithinLimit(block, content);
    return this.deps.repo.updateContent(agentId, blockName, content);
  }

  private async loadBlockOrThrow(
    agentId: string,
    blockName: string,
  ): Promise<CoreMemoryBlock> {
    const block = await this.deps.repo.findOne(agentId, blockName);
    if (!block) throw new BlockNotFoundError(agentId, blockName);
    return block;
  }

  private assertWithinLimit(block: CoreMemoryBlock, content: string): void {
    if (content.length > block.char_limit) {
      throw new CharLimitExceededError(
        block.block_name,
        content.length,
        block.char_limit,
      );
    }
  }
}
