import type { Agent, HierarchyLevel, ReviewPolicy, RuntimeConfig } from "../../domain/agent.js";
import type { AgentRepository, NewAgent, AgentPatch } from "../../ports/agent-repo.js";
import type { Pool } from "./client.js";
import { buildPatchClause } from "./pg-helpers.js";
import type { AgentRow } from "./row-types.js";

export class PostgresAgentRepository implements AgentRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Agent | undefined> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async findByApiKey(apiKey: string): Promise<Agent | undefined> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent WHERE api_key = $1 LIMIT 1`,
      [apiKey],
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async findByOwnerId(ownerId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent WHERE owner_id = $1 ORDER BY created_at ASC`,
      [ownerId],
    );
    return rows.map(rowToAgent);
  }

  async findTopLevelForOwner(ownerId: string): Promise<Agent | undefined> {
    // team before org — alphabetical DESC picks 'team' over 'org'
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent
        WHERE owner_id = $1
          AND hierarchy_level IN ('team', 'org')
        ORDER BY hierarchy_level DESC
        LIMIT 1`,
      [ownerId],
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async findSubordinates(parentAgentId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent WHERE parent_agent_id = $1 ORDER BY name ASC`,
      [parentAgentId],
    );
    return rows.map(rowToAgent);
  }

  async findPeers(agentId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT peer.* FROM agent peer
         JOIN agent self ON self.id = $1
        WHERE peer.id <> self.id
          AND peer.hierarchy_level = self.hierarchy_level
          AND peer.parent_agent_id IS NOT DISTINCT FROM self.parent_agent_id
        ORDER BY peer.name ASC`,
      [agentId],
    );
    return rows.map(rowToAgent);
  }

  async findParent(agentId: string): Promise<Agent | undefined> {
    // Single query via self-join: parent.id = self.parent_agent_id.
    // Returns nothing for top-level agents (parent_agent_id IS NULL).
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT parent.* FROM agent self
         JOIN agent parent ON parent.id = self.parent_agent_id
        WHERE self.id = $1
        LIMIT 1`,
      [agentId],
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async findByLevel(level: HierarchyLevel): Promise<Agent[]> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agent WHERE hierarchy_level = $1 ORDER BY name ASC`,
      [level],
    );
    return rows.map(rowToAgent);
  }

  async create(input: NewAgent): Promise<Agent> {
    const { rows } = await this.pool.query<AgentRow>(
      `INSERT INTO agent (
         id, name, owner_id, parent_agent_id, hierarchy_level,
         api_key, review_policy, runtime_config,
         max_task_sessions, max_mesh_sessions, max_negotiation_rounds,
         preferred_runtime_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.id,
        input.name,
        input.owner_id,
        input.parent_agent_id ?? null,
        input.hierarchy_level,
        input.api_key ?? null,
        input.review_policy ?? null,
        input.runtime_config,
        input.max_task_sessions ?? null,
        input.max_mesh_sessions ?? null,
        input.max_negotiation_rounds ?? null,
        input.preferred_runtime_id ?? null,
      ],
    );
    return rowToAgent(rows[0]!);
  }

  async update(id: string, patch: AgentPatch): Promise<Agent> {
    const clause = buildPatchClause<AgentPatch>(patch, {
      name: "name",
      owner_id: "owner_id",
      parent_agent_id: "parent_agent_id",
      hierarchy_level: "hierarchy_level",
      api_key: "api_key",
      review_policy: "review_policy",
      runtime_config: "runtime_config",
      max_task_sessions: "max_task_sessions",
      max_mesh_sessions: "max_mesh_sessions",
      max_negotiation_rounds: "max_negotiation_rounds",
      preferred_runtime_id: "preferred_runtime_id",
      archived_at: "archived_at",
    });

    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Agent not found: ${id}`);
      return existing;
    }

    clause.fields.push(`updated_at = NOW()`);

    const { rows } = await this.pool.query<AgentRow>(
      `UPDATE agent SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`Agent not found: ${id}`);
    return rowToAgent(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent WHERE id = $1`, [id]);
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    parent_agent_id: row.parent_agent_id ?? undefined,
    hierarchy_level: row.hierarchy_level as HierarchyLevel,
    api_key: row.api_key ?? undefined,
    review_policy: (row.review_policy ?? undefined) as ReviewPolicy | undefined,
    runtime_config: row.runtime_config as RuntimeConfig,
    max_task_sessions: row.max_task_sessions ?? undefined,
    max_mesh_sessions: row.max_mesh_sessions ?? undefined,
    max_negotiation_rounds: row.max_negotiation_rounds ?? undefined,
    preferred_runtime_id: row.preferred_runtime_id ?? undefined,
    archived_at: row.archived_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
