import type { NewRuntime, Runtime } from "../../domain/runtime.js";
import type {
  RuntimePatch,
  RuntimeRepository,
} from "../../ports/runtime-repo.js";
import type { Pool } from "./client.js";
import { buildPatchClause } from "./pg-helpers.js";
import type { RuntimeRow } from "./row-types.js";

function rowToRuntime(row: RuntimeRow): Runtime {
  return {
    id: row.id,
    daemon_id: row.daemon_id,
    cli: row.cli,
    cli_version: row.cli_version ?? undefined,
    last_heartbeat: row.last_heartbeat ?? undefined,
    capabilities: row.capabilities ?? {},
    created_at: row.created_at,
  };
}

export class PostgresRuntimeRepository implements RuntimeRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Runtime | undefined> {
    const { rows } = await this.pool.query<RuntimeRow>(
      `SELECT * FROM runtime WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToRuntime(rows[0]) : undefined;
  }

  async findByDaemonAndCli(
    daemonId: string,
    cli: string,
  ): Promise<Runtime | undefined> {
    const { rows } = await this.pool.query<RuntimeRow>(
      `SELECT * FROM runtime WHERE daemon_id = $1 AND cli = $2 LIMIT 1`,
      [daemonId, cli],
    );
    return rows[0] ? rowToRuntime(rows[0]) : undefined;
  }

  async listByDaemon(daemonId: string): Promise<Runtime[]> {
    const { rows } = await this.pool.query<RuntimeRow>(
      `SELECT * FROM runtime WHERE daemon_id = $1 ORDER BY cli ASC`,
      [daemonId],
    );
    return rows.map(rowToRuntime);
  }

  async listByOwnerAndCli(
    ownerPersonId: string,
    cli: string,
  ): Promise<Runtime[]> {
    const { rows } = await this.pool.query<RuntimeRow>(
      `SELECT r.*
         FROM runtime r
         JOIN daemon d ON d.id = r.daemon_id
        WHERE d.owner_person_id = $1
          AND d.revoked_at IS NULL
          AND r.cli = $2
        ORDER BY r.last_heartbeat DESC NULLS LAST`,
      [ownerPersonId, cli],
    );
    return rows.map(rowToRuntime);
  }

  async create(input: NewRuntime): Promise<Runtime> {
    const { rows } = await this.pool.query<RuntimeRow>(
      `INSERT INTO runtime (
         id, daemon_id, cli, cli_version, capabilities, created_at
       ) VALUES (
         $1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), COALESCE($6, now())
       )
       RETURNING *`,
      [
        input.id,
        input.daemon_id,
        input.cli,
        input.cli_version ?? null,
        input.capabilities ? JSON.stringify(input.capabilities) : null,
        input.created_at ?? null,
      ],
    );
    if (!rows[0]) throw new Error("runtime INSERT returned no row");
    return rowToRuntime(rows[0]);
  }

  async update(id: string, patch: RuntimePatch): Promise<Runtime> {
    // capabilities is JSONB and needs JSON.stringify before binding;
    // buildPatchClause handles the rest.
    const normalized: RuntimePatch = patch.capabilities
      ? { ...patch, capabilities: JSON.stringify(patch.capabilities) as unknown as Record<string, unknown> }
      : patch;
    const clause = buildPatchClause<RuntimePatch>(normalized, {
      cli_version: "cli_version",
      last_heartbeat: "last_heartbeat",
      capabilities: "capabilities",
    });
    if (clause.fields.length === 0) {
      const found = await this.findById(id);
      if (!found) throw new Error(`runtime ${id} not found`);
      return found;
    }
    const { rows } = await this.pool.query<RuntimeRow>(
      `UPDATE runtime SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`runtime ${id} not found`);
    return rowToRuntime(rows[0]);
  }

  async heartbeat(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE runtime SET last_heartbeat = now() WHERE id = $1`,
      [id],
    );
  }
}
