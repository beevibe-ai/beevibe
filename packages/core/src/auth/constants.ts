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

/**
 * Email shape check for the sign-in / sign-up / invite surfaces.
 *
 * Deliberately permissive — one `@`, a dot in the domain, no spaces.
 * It exists to catch typos before a round trip, not to decide
 * deliverability, which only sending can establish.
 *
 * This lived as three byte-identical private `EMAIL_RE` copies (the
 * `/signin` route, the `/signup` route and the web invite dialog). A
 * validation regex is the wrong thing to keep three copies of: loosen
 * one and the surfaces disagree about what an address is, and the
 * mismatch shows up as a client that accepts an address the server
 * then 400s.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` has the shape of an email address. */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}
