/**
 * Self-serve signup. UNAUTHENTICATED. Anyone with the public web URL
 * can mint themselves a person + their primary team agent + a `bv_u_`
 * key in one POST. Used by the web's `/sign-up` page.
 *
 * Idempotent on email: a second signup with the same email returns the
 * existing person's key (and provisions a missing team agent if any),
 * so users who lost their key can recover by re-signing-up. The email
 * column has an index but no UNIQUE constraint — there's a thin race
 * window where two concurrent signups with the same email both win,
 * but that's acceptable for the demo and trivially fixable with a
 * partial unique index when this becomes load-bearing.
 *
 * Production lockdown: set `BEEVIBE_SIGNUP_ENABLED=0` (or omit the
 * route from the bootstrap mount) to disable this entirely.
 */

import { Router, type Response } from "express";
import {
  agentId as makeAgentId,
  personId as makePersonId,
  type AgentRepository,
  type CoreMemoryBlockRepository,
  type PersonRepository,
} from "@beevibe/core";
import {
  hashPassword,
  provisionAgent,
  provisionUser,
  validatePasswordShape,
  verifyPassword,
} from "@beevibe/core/auth";

export interface SignupRoutesDeps {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  coreMemoryRepo: CoreMemoryBlockRepository;
  /** Default true. Set to false to 404 the route. */
  enabled?: boolean;
}

const NAME_RE = /^[\p{L}\p{N} '\-_.]{1,80}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function handleError(err: unknown, res: Response): void {
  console.error("[signup route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createSignupRouter(deps: SignupRoutesDeps): Router {
  const router = Router();
  const enabled = deps.enabled ?? true;

  router.post("/signup", async (req, res) => {
    if (!enabled) {
      res.status(404).json({ error: "signup_disabled" });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!name || !NAME_RE.test(name)) {
        res.status(400).json({
          error: "invalid_name",
          message:
            "name is required, 1-80 chars, letters/numbers/spaces/.-_'/ only",
        });
        return;
      }
      if (!email || !EMAIL_RE.test(email)) {
        res.status(400).json({ error: "invalid_email", message: "valid email required" });
        return;
      }
      const pwdCheck = validatePasswordShape(password);
      if (!pwdCheck.ok) {
        res.status(400).json({
          error: "invalid_password",
          message: `password ${pwdCheck.reason}`,
        });
        return;
      }

      // Idempotent on email. Two cases when the row already exists:
      //   1. has password_hash → verify the supplied password matches
      //      before returning the key (otherwise this would be a
      //      credential-stuffing oracle for any known email)
      //   2. no password_hash (legacy / seeded user) → set the supplied
      //      password as their first password and return the key
      const existing = await deps.personRepo.findByEmail(email);
      let key: string;
      let person_id: string;
      let person_name: string;

      if (existing?.api_key) {
        if (existing.password_hash) {
          const match = await verifyPassword(password, existing.password_hash);
          if (!match) {
            res.status(401).json({
              error: "invalid_credentials",
              message: "An account exists for that email, but the password didn't match.",
            });
            return;
          }
        } else {
          // First password set on a legacy account — adopt this password.
          await deps.personRepo.update(existing.id, {
            password_hash: await hashPassword(password),
          });
        }
        key = existing.api_key;
        person_id = existing.id;
        person_name = existing.name;
      } else {
        const password_hash = await hashPassword(password);
        const result = await provisionUser(
          { personRepo: deps.personRepo },
          { id: makePersonId(), name, email, password_hash },
        );
        key = result.apiKey;
        person_id = result.person.id;
        person_name = result.person.name;
      }

      let team = await deps.agentRepo.findTopLevelForOwner(person_id);
      if (!team) {
        const provisioned = await provisionAgent(
          { agentRepo: deps.agentRepo, coreMemoryRepo: deps.coreMemoryRepo },
          {
            id: makeAgentId(),
            name: `${person_name}'s team`,
            owner_id: person_id,
            hierarchy_level: "team",
            // Phase 1 normalized the cli name to "claude" (was "claude-code"
            // on the feature branch). model: undefined so the runtime picks
            // its default rather than us hard-coding a specific opus version.
            runtime_config: { type: "claude" },
          },
        );
        team = provisioned.agent;
      }

      // Personal room auto-creation deferred to Phase 11 when the room
      // schema + repo land. For now signup just mints person + key + team
      // agent; the user lands in /chat.

      res.json({
        ok: true,
        api_key: key,
        person: { id: person_id, name: person_name, email },
        primary_agent: {
          id: team.id,
          name: team.name,
          hierarchy: team.hierarchy_level,
        },
        existed: !!existing?.api_key,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}
