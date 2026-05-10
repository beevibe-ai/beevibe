import type { Person } from "../../domain/person.js";
import type { PersonRepository, NewPerson, PersonPatch } from "../../ports/person-repo.js";
import type { Pool } from "./client.js";
import { buildPatchClause } from "./pg-helpers.js";
import type { PersonRow } from "./row-types.js";

export class PostgresPersonRepository implements PersonRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Person | undefined> {
    const { rows } = await this.pool.query<PersonRow>(
      `SELECT * FROM person WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<Person | undefined> {
    const { rows } = await this.pool.query<PersonRow>(
      `SELECT * FROM person WHERE email = $1 LIMIT 1`,
      [email],
    );
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }

  async findByApiKey(apiKey: string): Promise<Person | undefined> {
    const { rows } = await this.pool.query<PersonRow>(
      `SELECT * FROM person WHERE api_key = $1 LIMIT 1`,
      [apiKey],
    );
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }

  async findManyByIds(ids: string[]): Promise<Person[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<PersonRow>(
      `SELECT * FROM person WHERE id = ANY($1::text[])`,
      [ids],
    );
    return rows.map(rowToPerson);
  }

  async create(input: NewPerson): Promise<Person> {
    const { rows } = await this.pool.query<PersonRow>(
      `INSERT INTO person (id, name, email, api_key, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.id,
        input.name,
        input.email ?? null,
        input.api_key ?? null,
        input.password_hash ?? null,
      ],
    );
    return rowToPerson(rows[0]!);
  }

  async update(id: string, patch: PersonPatch): Promise<Person> {
    const clause = buildPatchClause<PersonPatch>(patch, {
      name: "name",
      email: "email",
      api_key: "api_key",
      password_hash: "password_hash",
      onboarding_completed_at: "onboarding_completed_at",
    });

    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Person not found: ${id}`);
      return existing;
    }

    clause.fields.push(`updated_at = NOW()`);

    const { rows } = await this.pool.query<PersonRow>(
      `UPDATE person SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
    );
    if (!rows[0]) throw new Error(`Person not found: ${id}`);
    return rowToPerson(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM person WHERE id = $1`, [id]);
  }
}

function rowToPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    api_key: row.api_key ?? undefined,
    password_hash: row.password_hash ?? undefined,
    onboarding_completed_at: row.onboarding_completed_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
