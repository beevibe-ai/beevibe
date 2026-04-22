import type { MemoryFact, MemoryScope } from "../../domain/memory.js";
import type {
  MemoryFactRepository,
  MemoryFactPatch,
  NewMemoryFact,
  VectorSearchParams,
} from "../../ports/memory-fact-repo.js";
import type { Pool } from "./client.js";
import type { MemoryFactRow } from "./row-types.js";

const FACT_COLUMNS =
  "id, agent_id, scope, fact_type, content, embedding::text AS embedding, source_session_ids, created_at";

/** pgvector's text literal form is `"[n,n,…]"`. */
function vectorToPgLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export class PostgresMemoryFactRepository implements MemoryFactRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<MemoryFact | undefined> {
    const { rows } = await this.pool.query<MemoryFactRow>(
      `SELECT ${FACT_COLUMNS} FROM memory_fact WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToFact(rows[0]) : undefined;
  }

  async findByIds(ids: string[]): Promise<MemoryFact[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<MemoryFactRow>(
      `SELECT ${FACT_COLUMNS} FROM memory_fact WHERE id = ANY($1::text[])`,
      [ids],
    );
    return rows.map(rowToFact);
  }

  async create(input: NewMemoryFact): Promise<MemoryFact> {
    const { rows } = await this.pool.query<MemoryFactRow>(
      `INSERT INTO memory_fact (
         id, agent_id, scope, fact_type, content, embedding, source_session_ids
       ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       RETURNING ${FACT_COLUMNS}`,
      [
        input.id,
        input.agent_id,
        input.scope,
        input.fact_type,
        input.content,
        vectorToPgLiteral(input.embedding),
        input.source_session_ids,
      ],
    );
    return rowToFact(rows[0]!);
  }

  async update(id: string, patch: MemoryFactPatch): Promise<MemoryFact> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.scope !== undefined) {
      fields.push(`scope = $${i++}`);
      values.push(patch.scope);
    }
    if (patch.fact_type !== undefined) {
      fields.push(`fact_type = $${i++}`);
      values.push(patch.fact_type);
    }
    if (patch.content !== undefined) {
      fields.push(`content = $${i++}`);
      values.push(patch.content);
    }
    if (patch.embedding !== undefined) {
      fields.push(`embedding = $${i++}::vector`);
      values.push(vectorToPgLiteral(patch.embedding));
    }
    if (patch.source_session_ids !== undefined) {
      // Atomic union: two parallel updates can't lose a session id — the
      // merge happens server-side, not via read-modify-write.
      fields.push(
        `source_session_ids = ARRAY(` +
          `SELECT DISTINCT elem FROM unnest(memory_fact.source_session_ids || $${i++}::text[]) elem` +
          `)`,
      );
      values.push(patch.source_session_ids);
    }
    if (fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Fact ${id} not found`);
      return existing;
    }
    values.push(id);
    const { rows } = await this.pool.query<MemoryFactRow>(
      `UPDATE memory_fact
          SET ${fields.join(", ")}
        WHERE id = $${i}
        RETURNING ${FACT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error(`Fact ${id} not found`);
    return rowToFact(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM memory_fact WHERE id = $1`, [id]);
  }

  async searchByVector(params: VectorSearchParams): Promise<MemoryFact[]> {
    const scopes: MemoryScope[] = Array.isArray(params.scope) ? params.scope : [params.scope];
    const vecLit = vectorToPgLiteral(params.embedding);
    const minSim = params.min_similarity ?? 0.0;
    const limit = params.limit ?? 10;
    const factTypes = params.fact_types ?? null;
    const { rows } = await this.pool.query<MemoryFactRow>(
      `SELECT ${FACT_COLUMNS},
              1 - (embedding <=> $1::vector) AS similarity
         FROM memory_fact
        WHERE agent_id = $2
          AND scope = ANY($3::text[])
          AND ($4::text[] IS NULL OR fact_type = ANY($4::text[]))
          AND (1 - (embedding <=> $1::vector)) >= $5
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $6`,
      [vecLit, params.agent_id, scopes, factTypes, minSim, limit],
    );
    return rows.map(rowToFact);
  }

  async listByAgentScope(
    agentId: string,
    scope: MemoryScope,
    limit = 100,
  ): Promise<MemoryFact[]> {
    const { rows } = await this.pool.query<MemoryFactRow>(
      `SELECT ${FACT_COLUMNS}
         FROM memory_fact
        WHERE agent_id = $1 AND scope = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [agentId, scope, limit],
    );
    return rows.map(rowToFact);
  }

  async listBySessionId(sessionId: string): Promise<MemoryFact[]> {
    const { rows } = await this.pool.query<MemoryFactRow>(
      `SELECT ${FACT_COLUMNS}
         FROM memory_fact
        WHERE $1 = ANY(source_session_ids)
        ORDER BY created_at DESC`,
      [sessionId],
    );
    return rows.map(rowToFact);
  }
}

function rowToFact(row: MemoryFactRow): MemoryFact {
  return {
    id: row.id,
    agent_id: row.agent_id,
    scope: row.scope as MemoryScope,
    fact_type: row.fact_type as MemoryFact["fact_type"],
    content: row.content,
    embedding: JSON.parse(row.embedding) as number[],
    source_session_ids: row.source_session_ids,
    created_at: row.created_at,
  };
}
