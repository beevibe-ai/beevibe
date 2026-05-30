/**
 * /secrets REST surface — the human-facing CRUD for the per-person
 * encrypted secret store. Used by the Settings page to manage API keys
 * + tokens that get injected as env vars into sandboxed `use_repo`
 * runs (the architecture-deep-research specialist needs this for
 * OPENAI_API_KEY + a search-provider key).
 *
 *   GET    /secrets                 List the caller's secrets.
 *                                   Returns metadata only — never
 *                                   ciphertext or decrypted values.
 *
 *   POST   /secrets       { name, value, description? }
 *                                   Upsert. Re-adding the same name
 *                                   rotates the stored value in place
 *                                   (single row per (person, name)).
 *
 *   DELETE /secrets/:id             Owner-scoped delete. 404 if the row
 *                                   doesn't exist OR belongs to another
 *                                   person (the repo's delete returns
 *                                   false either way).
 *
 * Auth: bv_u_ (human) only. The MCP / agent path consumes secrets via
 * the use_repo tool, not via this REST surface.
 *
 * Names follow SCREAMING_SNAKE_CASE env-var convention: the value will
 * be passed verbatim to `docker run --env NAME=VALUE`, so the name has
 * to be a valid env-var identifier. Validated at the route level.
 */
import { Router, type RequestHandler } from "express";
import type { PersonSecretRepository } from "@beevibe/core";
import { personSecretId } from "@beevibe/core";
import { encryptSecret } from "@beevibe/core/auth";
import { requireHuman } from "../auth/middleware.js";

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 16_384;
const MAX_DESCRIPTION_LENGTH = 512;

export interface SecretsRouterDeps {
  authMiddleware: RequestHandler;
  personSecretRepo: PersonSecretRepository;
}

export function createSecretsRouter(deps: SecretsRouterDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // GET /secrets — list metadata only.
  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const secrets = await deps.personSecretRepo.listByPerson(
        req.caller!.personId,
      );
      res.json({ secrets });
    } catch (err) {
      console.error("[secrets/list]", err);
      res.status(500).json({ error: "list_failed" });
    }
  });

  // POST /secrets — upsert (insert OR rotate).
  router.post("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const body = req.body as Partial<{
      name: string;
      value: string;
      description: string;
    }>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : undefined;

    if (!name) {
      res.status(400).json({ error: "missing_name" });
      return;
    }
    if (name.length > MAX_NAME_LENGTH || !ENV_VAR_NAME_RE.test(name)) {
      res.status(400).json({
        error: "invalid_name",
        message: `name must be a SCREAMING_SNAKE_CASE env-var (max ${MAX_NAME_LENGTH} chars)`,
      });
      return;
    }
    if (!value) {
      res.status(400).json({ error: "missing_value" });
      return;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      res.status(400).json({
        error: "value_too_large",
        message: `value must be at most ${MAX_VALUE_LENGTH} chars`,
      });
      return;
    }
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({
        error: "description_too_large",
        message: `description must be at most ${MAX_DESCRIPTION_LENGTH} chars`,
      });
      return;
    }

    try {
      // encryptSecret throws if BEEVIBE_SECRETS_KEY isn't configured;
      // surface that as 500 with a clear error so misconfigured envs
      // don't silently corrupt rows.
      const encrypted = encryptSecret(value);
      const saved = await deps.personSecretRepo.upsert({
        id: personSecretId(),
        person_id: req.caller!.personId,
        name,
        description,
        value_encrypted: encrypted.value_encrypted,
        value_iv: encrypted.value_iv,
        value_tag: encrypted.value_tag,
      });
      // Return metadata only — value never leaves the server.
      res.status(201).json({ secret: saved });
    } catch (err) {
      // Don't include the original error message in the body; it could
      // contain fragments of the value on validation failures.
      console.error(
        "[secrets/upsert]",
        err instanceof Error ? err.message : String(err),
      );
      if (err instanceof Error && /BEEVIBE_SECRETS_KEY/.test(err.message)) {
        res.status(500).json({
          error: "secrets_key_unconfigured",
          message:
            "Server cannot encrypt secrets — BEEVIBE_SECRETS_KEY is not set. Contact the operator.",
        });
        return;
      }
      res.status(500).json({ error: "upsert_failed" });
    }
  });

  // DELETE /secrets/:id — owner-scoped.
  router.delete("/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    try {
      const ok = await deps.personSecretRepo.delete(id, req.caller!.personId);
      if (!ok) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      console.error("[secrets/delete]", err);
      res.status(500).json({ error: "delete_failed" });
    }
  });

  return router;
}
