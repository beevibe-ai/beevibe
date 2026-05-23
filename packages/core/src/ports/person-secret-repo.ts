import type {
  PersonSecret,
  PersonSecretRecord,
} from "../domain/person-secret.js";

export type NewPersonSecretInput = {
  id: string;
  person_id: string;
  name: string;
  description?: string;
  value_encrypted: string;
  value_iv: string;
  value_tag: string;
};

export type PersonSecretPatch = {
  value_encrypted?: string;
  value_iv?: string;
  value_tag?: string;
  description?: string;
};

export interface PersonSecretRepository {
  /**
   * List a person's secrets WITHOUT ciphertext — for the settings UI.
   * The api route layer should never return PersonSecretRecord shapes
   * to clients.
   */
  listByPerson(personId: string): Promise<PersonSecret[]>;

  /**
   * Read a single secret WITH ciphertext, for server-side decryption
   * in the sandbox-injection path. Returns undefined if the secret
   * doesn't exist OR doesn't belong to `personId` (so the caller
   * doesn't need a separate ownership check).
   */
  findRecord(personId: string, name: string): Promise<PersonSecretRecord | undefined>;

  /**
   * Batch-fetch records for a set of names, all scoped to one person.
   * Returns a map keyed by name; missing names are simply absent.
   * Used by use_repo to load the requested secrets in one round-trip.
   */
  findRecordsByNames(
    personId: string,
    names: string[],
  ): Promise<Map<string, PersonSecretRecord>>;

  /** Upsert is intentional — `name` is unique per person, so a re-add overwrites. */
  upsert(input: NewPersonSecretInput): Promise<PersonSecret>;

  delete(id: string, personId: string): Promise<boolean>;
}
