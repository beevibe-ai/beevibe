/**
 * Per-person encrypted secret — typically an API key or token a
 * person's agents need to inject into sandboxed `use_repo` runs as
 * env vars (e.g. OPENAI_API_KEY for the architecture-deep-research
 * specialist).
 *
 * See migration 1781200000000_add-person-secret.sql for schema and
 * threat model. See packages/core/src/auth/secrets.ts for the AES-GCM
 * helpers that produce the stored shape.
 *
 * `value_encrypted` / `value_iv` / `value_tag` are intentionally NOT
 * exposed via this type — domain readers shouldn't need ciphertext.
 * Use {@link PersonSecretRecord} when working directly against the row.
 */

export interface PersonSecret {
  id: string;
  person_id: string;
  /** Env-var-style name. Convention: SCREAMING_SNAKE_CASE. */
  name: string;
  description?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Internal full row shape including the ciphertext fields. Use only
 * inside the api/core auth layer that decrypts; never expose to clients.
 */
export interface PersonSecretRecord extends PersonSecret {
  value_encrypted: string;
  value_iv: string;
  value_tag: string;
}
