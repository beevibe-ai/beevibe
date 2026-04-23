import type { Person } from "../domain/person.js";

export type NewPerson = Omit<Person, "created_at" | "updated_at">;

export type PersonPatch = Partial<Omit<Person, "id" | "created_at" | "updated_at">>;

export interface PersonRepository {
  findById(id: string): Promise<Person | undefined>;

  findByEmail(email: string): Promise<Person | undefined>;

  /**
   * Resolve a person by their human-scoped bv_u_ API key.
   * Used by auth.lookupApiKey to dispatch bv_u_-prefixed tokens.
   */
  findByApiKey(apiKey: string): Promise<Person | undefined>;

  /** Batch lookup for hydrating names in task lists, etc. */
  findManyByIds(ids: string[]): Promise<Person[]>;

  create(input: NewPerson): Promise<Person>;

  update(id: string, patch: PersonPatch): Promise<Person>;

  delete(id: string): Promise<void>;
}
