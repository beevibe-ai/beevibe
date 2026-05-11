import type { Pool } from "./client.js";
import type {
  AgentProvisionEvent,
  AgentProvisionEventRepository,
  NewAgentProvisionEvent,
} from "../../ports/agent-provision-event-repo.js";

interface AgentProvisionEventRow {
  id: string;
  parent_agent_id: string;
  child_agent_id: string;
  owner_person_id: string;
  child_name: string;
  persona: string;
  domain: string;
  created_at: Date;
}

function rowToEvent(row: AgentProvisionEventRow): AgentProvisionEvent {
  return {
    id: row.id,
    parent_agent_id: row.parent_agent_id,
    child_agent_id: row.child_agent_id,
    owner_person_id: row.owner_person_id,
    child_name: row.child_name,
    persona: row.persona,
    domain: row.domain,
    created_at: row.created_at,
  };
}

export class PostgresAgentProvisionEventRepository
  implements AgentProvisionEventRepository
{
  constructor(private readonly pool: Pool) {}

  async create(input: NewAgentProvisionEvent): Promise<AgentProvisionEvent> {
    const { rows } = await this.pool.query<AgentProvisionEventRow>(
      `INSERT INTO agent_provision_event (
         id, parent_agent_id, child_agent_id, owner_person_id,
         child_name, persona, domain, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
       RETURNING *`,
      [
        input.id,
        input.parent_agent_id,
        input.child_agent_id,
        input.owner_person_id,
        input.child_name,
        input.persona,
        input.domain,
        input.created_at ?? null,
      ],
    );
    return rowToEvent(rows[0]!);
  }

  async countByParentSince(
    parentAgentId: string,
    windowSeconds: number,
  ): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM agent_provision_event
        WHERE parent_agent_id = $1
          AND created_at >= NOW() - ($2 * INTERVAL '1 second')`,
      [parentAgentId, windowSeconds],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listByParent(
    parentAgentId: string,
    limit = 50,
  ): Promise<AgentProvisionEvent[]> {
    const { rows } = await this.pool.query<AgentProvisionEventRow>(
      `SELECT * FROM agent_provision_event
        WHERE parent_agent_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [parentAgentId, limit],
    );
    return rows.map(rowToEvent);
  }
}
