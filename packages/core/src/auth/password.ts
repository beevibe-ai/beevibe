/**
 * Password hashing for human sign-in. Uses Node's stdlib scrypt — no
 * extra dep, no native bindings. OWASP-approved KDF for password
 * storage alongside argon2 / bcrypt.
 *
 * Stored format is one self-describing TEXT field:
 *
 *   scrypt$N=...,r=...,p=...$<salt-hex>$<derived-hex>
 *
 * The cost params live in the hash itself so we can rotate them in a
 * future migration without breaking older rows — `verifyPassword` reads
 * whatever params each row was hashed with.
 *
 * Defaults are calibrated for ~100ms on a 2024-era laptop CPU; sign-in
 * traffic is low so the cost is fine. If we get a brute-force surface
 * exposed, we bump N here, and any future signups / password changes
 * land at the new cost; existing rows stay valid.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384; // 2^14 — ~32MB, ~100ms on modern CPUs
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt's default maxmem (32MB) doesn't fit N=16384 r=8 — bump it so
// the call doesn't reject. 128 * N * r bytes is the spec, so we give
// headroom + a constant for OS overhead.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

// PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH / SIGNIN_NO_PASSWORD_SET
// live in ./constants.ts so the web bundle can import them without
// pulling in node:crypto. Re-exported via the barrel for convenience.
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "./constants.js";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString(
    "hex",
  )}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const params = Object.fromEntries(
    parts[1]!.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  ) as Record<string, string>;
  const N = Number(params.N);
  const r = Number(params.r);
  const p = Number(params.p);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, "hex");
    expected = Buffer.from(parts[3]!, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    // Allow whatever the stored params demand — this is per-row so
    // historic high-cost rows still verify.
    maxmem: 128 * N * r * 2,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Minimal validation — length-only, no complexity rules (NIST 800-63B). */
export function validatePasswordShape(password: string): {
  ok: boolean;
  reason?: string;
} {
  if (typeof password !== "string") return { ok: false, reason: "required" };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: `must be at most ${PASSWORD_MAX_LENGTH} characters` };
  }
  return { ok: true };
}
