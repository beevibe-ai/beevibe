import type { Daemon, NewDaemon } from "../../domain/daemon.js";
import type {
  DaemonPatch,
  DaemonRepository,
} from "../../ports/daemon-repo.js";
import type { Pool } from "./client.js";
import { buildPatchClause } from "./pg-helpers.js";
import type { DaemonRow } from "./row-types.js";

function rowToDaemon(row: DaemonRow): Daemon {
  return {
    id: row.id,
    owner_person_id: row.owner_person_id,
    external_id: row.external_id,
    device_name: row.device_name,
    token_hash: row.token_hash,
    last_seen_at: row.last_seen_at ?? undefined,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? undefined,
  };
}

export class PostgresDaemonRepository implements DaemonRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Daemon | undefined> {
    const { rows } = await this.pool.query<DaemonRow>(
      `SELECT * FROM daemon WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToDaemon(rows[0]) : undefined;
  }

  async findByOwnerAndExternalId(
    ownerPersonId: string,
    externalId: string,
  ): Promise<Daemon | undefined> {
    const { rows } = await this.pool.query<DaemonRow>(
      `SELECT * FROM daemon
        WHERE owner_person_id = $1 AND external_id = $2
        LIMIT 1`,
      [ownerPersonId, externalId],
    );
    return rows[0] ? rowToDaemon(rows[0]) : undefined;
  }

  async findByTokenHash(tokenHash: string): Promise<Daemon | undefined> {
    const { rows } = await this.pool.query<DaemonRow>(
      `SELECT * FROM daemon
        WHERE token_hash = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [tokenHash],
    );
    return rows[0] ? rowToDaemon(rows[0]) : undefined;
  }

  async listActiveByOwner(ownerPersonId: string): Promise<Daemon[]> {
    const { rows } = await this.pool.query<DaemonRow>(
      `SELECT * FROM daemon
        WHERE owner_person_id = $1 AND revoked_at IS NULL
        ORDER BY created_at ASC`,
      [ownerPersonId],
    );
    return rows.map(rowToDaemon);
  }

  async create(input: NewDaemon): Promise<Daemon> {
    const { rows } = await this.pool.query<DaemonRow>(
      `INSERT INTO daemon (
         id, owner_person_id, external_id, device_name, token_hash, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, COALESCE($6, now())
       )
       RETURNING *`,
      [
        input.id,
        input.owner_person_id,
        input.external_id,
        input.device_name,
        input.token_hash,
        input.created_at ?? null,
      ],
    );
    if (!rows[0]) throw new Error("daemon INSERT returned no row");
    return rowToDaemon(rows[0]);
  }

  async update(id: string, patch: DaemonPatch): Promise<Daemon> {
    const clause = buildPatchClause<DaemonPatch>(patch, {
      device_name: "device_name",
      token_hash: "token_hash",
      last_seen_at: "last_seen_at",
      revoked_at: "revoked_at",
    });
    if (clause.fields.length === 0) {
      const found = await this.findById(id);
      if (!found) throw new Error(`daemon ${id} not found`);
      return found;
    }
    const { rows } = await this.pool.query<DaemonRow>(
      `UPDATE daemon SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`daemon ${id} not found`);
    return rowToDaemon(rows[0]);
  }

  async touchLastSeen(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE daemon SET last_seen_at = now() WHERE id = $1`,
      [id],
    );
  }

  async revoke(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE daemon SET revoked_at = now() WHERE id = $1`,
      [id],
    );
  }
}
