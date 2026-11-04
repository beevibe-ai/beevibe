import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import { DEFAULT_BLOCK_TEMPLATES } from "../../domain/core-memory.js";
import type { HierarchyLevel } from "../../domain/agent.js";
import { blockId } from "../../domain/ids.js";
import type {
  CoreMemoryBlockRepository,
  NewCoreMemoryBlock,
} from "../../ports/core-memory-repo.js";
import type { Pool } from "./client.js";
import type { CoreMemoryBlockRow } from "./row-types.js";
import { queryExpectOne, queryMany, queryOne } from "./pg-helpers.js";

export class PostgresCoreMemoryRepository implements CoreMemoryBlockRepository {
  constructor(private pool: Pool) {}

  async findByAgent(agentId: string): Promise<CoreMemoryBlock[]> {
    return queryMany(
      this.pool,
      `SELECT * FROM core_memory_block
        WHERE agent_id = $1
        ORDER BY block_name ASC`,
      [agentId],
      rowToBlock,
    );
  }

  async findOne(agentId: string, blockName: string): Promise<CoreMemoryBlock | undefined> {
    return queryOne(
      this.pool,
      `SELECT * FROM core_memory_block
        WHERE agent_id = $1 AND block_name = $2
        LIMIT 1`,
      [agentId, blockName],
      rowToBlock,
    );
  }

  async upsert(input: NewCoreMemoryBlock): Promise<CoreMemoryBlock> {
    return queryExpectOne(
      this.pool,
      `INSERT INTO core_memory_block (
         id, agent_id, block_name, content, char_limit, is_system, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_id, block_name) DO UPDATE SET
         content     = EXCLUDED.content,
         char_limit  = EXCLUDED.char_limit,
         is_system   = EXCLUDED.is_system,
         description = EXCLUDED.description,
         updated_at  = NOW()
       RETURNING *`,
      [
        input.id,
        input.agent_id,
        input.block_name,
        input.content,
        input.char_limit,
        input.is_system,
        input.description ?? "",
      ],
      rowToBlock,
    );
  }

  async updateContent(
    agentId: string,
    blockName: string,
    content: string,
  ): Promise<CoreMemoryBlock> {
    const { rows } = await this.pool.query<CoreMemoryBlockRow>(
      `UPDATE core_memory_block
          SET content = $3,
              updated_at = NOW()
        WHERE agent_id = $1 AND block_name = $2
        RETURNING *`,
      [agentId, blockName, content],
    );
    if (!rows[0]) {
      throw new Error(`Block "${blockName}" for agent ${agentId} not found`);
    }
    return rowToBlock(rows[0]);
  }

  async delete(agentId: string, blockName: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM core_memory_block WHERE agent_id = $1 AND block_name = $2`,
      [agentId, blockName],
    );
  }

  async initDefaults(agentId: string, level: HierarchyLevel): Promise<CoreMemoryBlock[]> {
    const templates = DEFAULT_BLOCK_TEMPLATES[level];
    if (templates.length === 0) return [];

    // Batch insert all templates in a single round-trip; ON CONFLICT preserves
    // existing rows' id + content (we pass EXCLUDED.* only for new inserts via
    // ON CONFLICT DO UPDATE which still runs — here we deliberately keep the
    // existing row's content on conflict since this is a "first-time init").
    const tuples: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const tmpl of templates) {
      tuples.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(
        blockId(),
        agentId,
        tmpl.block_name,
        tmpl.initial_content,
        tmpl.char_limit,
        tmpl.is_system,
        tmpl.description,
      );
    }

    // ON CONFLICT updates `description` so re-running initDefaults on an
    // existing agent (e.g. after a template description was tightened in
    // code) refreshes the agent-facing guidance. Content is preserved.
    return queryMany(
      this.pool,
      `INSERT INTO core_memory_block (
         id, agent_id, block_name, content, char_limit, is_system, description
       ) VALUES ${tuples.join(", ")}
       ON CONFLICT (agent_id, block_name) DO UPDATE SET
         description = EXCLUDED.description,
         updated_at  = NOW()
       RETURNING *`,
      values,
      rowToBlock,
    );
  }
}

function rowToBlock(row: CoreMemoryBlockRow): CoreMemoryBlock {
  return {
    id: row.id,
    agent_id: row.agent_id,
    block_name: row.block_name,
    content: row.content,
    char_limit: row.char_limit,
    is_system: row.is_system,
    description: row.description ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
