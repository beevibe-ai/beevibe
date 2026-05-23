/**
 * Postgres adapter for {@link PersonSecretRepository}.
 *
 * The two read paths are intentionally distinct:
 *   - listByPerson + similar metadata reads NEVER select value_encrypted
 *     / value_iv / value_tag. Keeps the ciphertext off any code path
 *     that might log a row or surface it to a client.
 *   - findRecord + findRecordsByNames are the explicit "I need to
 *     decrypt" paths and pull the ciphertext columns.
 *
 * Upsert collapses re-add into rotate-in-place: the unique
 * (person_id, name) constraint guarantees at most one row per env-var
 * name per person, so the settings UI's "add" button works for both
 * first-time and rotation flows.
 */
import type { Pool } from "./client.js";
import type {
  PersonSecret,
  PersonSecretRecord,
} from "../../domain/person-secret.js";
import type {
  NewPersonSecretInput,
  PersonSecretRepository,
} from "../../ports/person-secret-repo.js";

interface PersonSecretListRow {
  id: string;
  person_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PersonSecretFullRow extends PersonSecretListRow {
  value_encrypted: string;
  value_iv: string;
  value_tag: string;
}

export class PostgresPersonSecretRepository implements PersonSecretRepository {
  constructor(private readonly pool: Pool) {}

  async listByPerson(personId: string): Promise<PersonSecret[]> {
    const { rows } = await this.pool.query<PersonSecretListRow>(
      `SELECT id, person_id, name, description, created_at, updated_at
         FROM person_secret
        WHERE person_id = $1
        ORDER BY name ASC`,
      [personId],
    );
    return rows.map(rowToSecret);
  }

  async findRecord(
    personId: string,
    name: string,
  ): Promise<PersonSecretRecord | undefined> {
    const { rows } = await this.pool.query<PersonSecretFullRow>(
      `SELECT id, person_id, name, description,
              value_encrypted, value_iv, value_tag,
              created_at, updated_at
         FROM person_secret
        WHERE person_id = $1 AND name = $2`,
      [personId, name],
    );
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async findRecordsByNames(
    personId: string,
    names: string[],
  ): Promise<Map<string, PersonSecretRecord>> {
    if (names.length === 0) return new Map();
    const { rows } = await this.pool.query<PersonSecretFullRow>(
      `SELECT id, person_id, name, description,
              value_encrypted, value_iv, value_tag,
              created_at, updated_at
         FROM person_secret
        WHERE person_id = $1 AND name = ANY($2::text[])`,
      [personId, names],
    );
    const map = new Map<string, PersonSecretRecord>();
    for (const row of rows) {
      map.set(row.name, rowToRecord(row));
    }
    return map;
  }

  async upsert(input: NewPersonSecretInput): Promise<PersonSecret> {
    const { rows } = await this.pool.query<PersonSecretListRow>(
      `INSERT INTO person_secret (
         id, person_id, name, description,
         value_encrypted, value_iv, value_tag
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (person_id, name) DO UPDATE SET
         value_encrypted = EXCLUDED.value_encrypted,
         value_iv = EXCLUDED.value_iv,
         value_tag = EXCLUDED.value_tag,
         description = COALESCE(EXCLUDED.description, person_secret.description),
         updated_at = NOW()
       RETURNING id, person_id, name, description, created_at, updated_at`,
      [
        input.id,
        input.person_id,
        input.name,
        input.description ?? null,
        input.value_encrypted,
        input.value_iv,
        input.value_tag,
      ],
    );
    return rowToSecret(rows[0]!);
  }

  async delete(id: string, personId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM person_secret WHERE id = $1 AND person_id = $2`,
      [id, personId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function rowToSecret(row: PersonSecretListRow): PersonSecret {
  return {
    id: row.id,
    person_id: row.person_id,
    name: row.name,
    description: row.description ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRecord(row: PersonSecretFullRow): PersonSecretRecord {
  return {
    ...rowToSecret(row),
    value_encrypted: row.value_encrypted,
    value_iv: row.value_iv,
    value_tag: row.value_tag,
  };
}
