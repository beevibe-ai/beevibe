import type { Person } from "../../domain/person.js";
import type { PersonRepository, NewPerson, PersonPatch } from "../../ports/person-repo.js";
import type { Pool } from "./client.js";
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
      `INSERT INTO person (id, name, email)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.id, input.name, input.email ?? null],
    );
    return rowToPerson(rows[0]!);
  }

  async update(id: string, patch: PersonPatch): Promise<Person> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (patch.name !== undefined) {
      fields.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.email !== undefined) {
      fields.push(`email = $${i++}`);
      values.push(patch.email ?? null);
    }

    if (fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Person not found: ${id}`);
      return existing;
    }

    fields.push(`updated_at = NOW()`);

    const { rows } = await this.pool.query<PersonRow>(
      `UPDATE person SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      [...values, id],
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
