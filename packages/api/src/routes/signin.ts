/**
 * `POST /signin` — credential exchange. UNAUTHENTICATED.
 *
 * Visitor presents `{email, password}`; on match we return their
 * existing `bv_u_` key. The key is the actual session token (web
 * persists it to localStorage and uses it as Bearer on every request);
 * the password is just the credential we use to *retrieve* the key.
 *
 * This means the bv_u_ key remains the durable per-user secret — same
 * as before, same as `/signup`, same as `pnpm provision-user`. We've
 * just added a "log in with credentials" path for users who don't
 * remember (or never knew) their key.
 *
 * Legacy / seeded users with `password_hash IS NULL` get a 409 with
 * `code='no_password_set'`. The web form falls back to the
 * "paste your bv_u_ key" sign-in for them.
 *
 * The 401 response intentionally collapses three failure modes into
 * one error string ("invalid_credentials") to avoid leaking which
 * emails exist:
 *   - email doesn't exist
 *   - email exists but no password set
 *   - email exists, password set, password didn't match
 *
 * Production lockdown: piggybacks on `BEEVIBE_SIGNUP_ENABLED` since
 * the same config gates self-serve user surfaces.
 */

import { Router, type Response } from "express";
import type { PersonRepository } from "@beevibe/core";
import { SIGNIN_NO_PASSWORD_SET, verifyPassword } from "@beevibe/core/auth";

export interface SigninRoutesDeps {
  personRepo: PersonRepository;
  /** Default true. Set to false to 404 the route. */
  enabled?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function handleError(err: unknown, res: Response): void {
  console.error("[signin route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createSigninRouter(deps: SigninRoutesDeps): Router {
  const router = Router();
  const enabled = deps.enabled ?? true;

  router.post("/signin", async (req, res) => {
    if (!enabled) {
      res.status(404).json({ error: "signin_disabled" });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!email || !EMAIL_RE.test(email)) {
        res
          .status(400)
          .json({ error: "invalid_email", message: "valid email required" });
        return;
      }
      if (!password) {
        res.status(400).json({
          error: "invalid_password",
          message: "password required",
        });
        return;
      }

      const person = await deps.personRepo.findByEmail(email);

      // Distinct response for "you exist but never set a password" — the
      // web form swaps to a "paste your key" path. Without this branch a
      // legacy seed user could never recover their account.
      if (person && person.api_key && !person.password_hash) {
        res.status(409).json({
          error: SIGNIN_NO_PASSWORD_SET,
          message:
            "This account predates passwords. Sign in with your bv_u_ key once, then set a password.",
        });
        return;
      }

      if (!person || !person.api_key || !person.password_hash) {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Email or password is incorrect.",
        });
        return;
      }

      const match = await verifyPassword(password, person.password_hash);
      if (!match) {
        res.status(401).json({
          error: "invalid_credentials",
          message: "Email or password is incorrect.",
        });
        return;
      }

      res.json({
        ok: true,
        api_key: person.api_key,
        person: {
          id: person.id,
          name: person.name,
          email: person.email ?? null,
        },
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
