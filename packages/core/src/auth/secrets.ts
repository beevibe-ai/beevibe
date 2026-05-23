/**
 * Symmetric encryption for the per-person secret store (api keys,
 * tokens) that gets injected into sandboxed `use_repo` runs as env
 * vars.
 *
 * Algorithm: AES-256-GCM via node's stdlib `createCipheriv`. GCM gives
 * authenticated encryption — tampering with the ciphertext makes
 * `decryptSecret` throw, so a compromised DB row can't silently inject
 * the wrong value. The 96-bit IV is per-row random; the 128-bit auth
 * tag is per-row from the cipher.
 *
 * Key material: 32 bytes (256 bits) read from the BEEVIBE_SECRETS_KEY
 * env var as 64 hex chars. Generated once per deployment with
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 * Rotating the key today requires re-encrypting all rows (no key-ring
 * support yet); flagged for follow-up when first rotation is needed.
 *
 * What this module is NOT:
 *   - not for hashing user passwords (use ./password.ts)
 *   - not for hashing API tokens stored on `person.api_key` (those are
 *     compared as plaintext — different threat model)
 *
 * Returned shape `{ value_encrypted, value_iv, value_tag }` maps 1:1
 * to the `person_secret` table columns of the same names.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // 256-bit key
const IV_BYTES = 12; // 96-bit nonce (GCM standard)
const TAG_BYTES = 16; // 128-bit auth tag

export interface EncryptedSecret {
  /** Hex-encoded ciphertext. */
  value_encrypted: string;
  /** Hex-encoded 12-byte IV. Unique per encryption. */
  value_iv: string;
  /** Hex-encoded 16-byte GCM auth tag. */
  value_tag: string;
}

let cachedKey: Buffer | undefined;

/**
 * Read + validate the master key from BEEVIBE_SECRETS_KEY env. Cached
 * for the process lifetime — the env var doesn't change at runtime.
 *
 * Throws a clear error if the key is missing or the wrong length so
 * mis-configuration surfaces at first encrypt/decrypt instead of
 * producing silent data corruption.
 */
export function getSecretsKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BEEVIBE_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "BEEVIBE_SECRETS_KEY is not set. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "hex");
  } catch {
    throw new Error("BEEVIBE_SECRETS_KEY must be hex-encoded");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `BEEVIBE_SECRETS_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Use 64 hex chars.`,
    );
  }
  cachedKey = key;
  return key;
}

/** Test seam — clears the cached key so tests can rotate it. */
export function __resetSecretsKeyForTests(): void {
  cachedKey = undefined;
}

/**
 * Encrypt a secret value (UTF-8 string) under the master key. The
 * returned shape maps directly onto person_secret's three storage
 * columns.
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptSecret: plaintext must be a string");
  }
  const key = getSecretsKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    value_encrypted: ciphertext.toString("hex"),
    value_iv: iv.toString("hex"),
    value_tag: tag.toString("hex"),
  };
}

/**
 * Inverse of {@link encryptSecret}. Throws if the ciphertext or tag
 * has been tampered with (GCM auth failure) — the API surface treats
 * this as a 500 and logs without the value (no `console.error(e)` with
 * `e` containing fragments of plaintext).
 */
export function decryptSecret(record: EncryptedSecret): string {
  const key = getSecretsKey();
  const iv = Buffer.from(record.value_iv, "hex");
  const tag = Buffer.from(record.value_tag, "hex");
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptSecret: iv must be ${IV_BYTES} bytes`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`decryptSecret: tag must be ${TAG_BYTES} bytes`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.value_encrypted, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
