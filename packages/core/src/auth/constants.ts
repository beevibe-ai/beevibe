/**
 * Auth constants safe to import from any environment (browser bundles
 * included). Kept separate from `password.ts` because that module
 * pulls in `node:crypto` for scrypt — webpack chokes on `node:` URIs
 * in client code.
 *
 * Anything web needs to validate or branch on lives here. Server-only
 * helpers (hashPassword, verifyPassword) stay in `password.ts`.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * Wire-format error code returned by `POST /signin` when the email
 * exists but no password has ever been set (legacy / seeded users).
 * Web reads this to swap the form into "paste your bv_u_ key" mode.
 */
export const SIGNIN_NO_PASSWORD_SET = "no_password_set";
