/**
 * Onboarding/identity surface for the human chat client.
 *
 * - `GET /me` — returns the caller's person + their primary agent + a
 *   `needs_onboarding` flag so the web's `/welcome` route can decide
 *   whether to redirect into the wizard or pass through to chat.
 * - `POST /me/onboarding/complete` — flips `person.onboarding_completed_at`
 *   so the wizard exit cannot trap the user. Idempotent.
 * - `GET /health/runtime` — verifies the dependencies the chat surface
 *   actually needs:
 *     - `claude` CLI present + spawnable (chat agents run as CLI
 *       subprocesses; auth flows through `~/.claude/` credentials, not
 *       through `ANTHROPIC_API_KEY`)
 *     - OpenAI embeddings reachable (memory briefing's vector recall
 *       relies on this; chat works without it but the team agent's
 *       memory will be cold).
 *   The Anthropic API key probe was deliberately removed: the chat
 *   doesn't use it (server-side fact merging/promotion does, but those
 *   fire post-session and surface their own errors via console.error).
 */

import { Router, type RequestHandler } from "express";
import type {
  AgentRepository,
  EmbeddingService,
  PersonRepository,
  RuntimeRegistry,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";

export interface MeRoutesDeps {
  authMiddleware: RequestHandler;
  personRepo: PersonRepository;
  agentRepo: AgentRepository;
  runtimeRegistry: RuntimeRegistry;
  /** Optional. When undefined, /health/runtime reports openai as `skipped`. */
  embed?: EmbeddingService;
}

export function createMeRouter(deps: MeRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/me", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const [person, agent] = await Promise.all([
      deps.personRepo.findById(req.caller.personId),
      deps.agentRepo.findTopLevelForOwner(req.caller.personId),
    ]);
    if (!person) {
      res.status(404).json({ error: "person_not_found" });
      return;
    }
    res.json({
      person: {
        id: person.id,
        name: person.name,
        email: person.email ?? null,
        onboarding_completed_at: person.onboarding_completed_at ?? null,
      },
      primary_agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            hierarchy: agent.hierarchy_level,
          }
        : null,
      needs_onboarding: !person.onboarding_completed_at,
    });
  });

  router.post("/me/onboarding/complete", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const updated = await deps.personRepo.update(req.caller.personId, {
      onboarding_completed_at: new Date(),
    });
    res.json({ ok: true, onboarding_completed_at: updated.onboarding_completed_at ?? null });
  });

  router.get("/health/runtime", async (req, res) => {
    if (!requireHuman(req, res)) return;
    // The chat path: spawn `claude` CLI. The runtime port's healthCheck
    // calls `claude --version` — fast, doesn't burn a turn.
    // Phase 1 normalized the registry key from "claude-code" to "claude".
    const claudeRuntime = deps.runtimeRegistry["claude"];
    const embed = deps.embed;
    const [cliResult, embedResult] = await Promise.allSettled([
      claudeRuntime
        ? claudeRuntime.healthCheck()
        : Promise.reject(new Error("claude runtime not registered")),
      embed ? embed.embed("ok") : Promise.resolve(null),
    ]);

    const cliOk =
      cliResult.status === "fulfilled" && cliResult.value.healthy;
    // OpenAI is "skipped" when no embed service was configured at boot
    // (no OPENAI_API_KEY). Wizard treats skipped as "ok-but-degraded"
    // and lets the user proceed; chat works without it. When configured,
    // skipped becomes ok/fail based on the actual probe result.
    const embedSkipped = !embed;
    const embedOk = embedSkipped || embedResult.status === "fulfilled";
    const ok = cliOk && embedOk;

    res.status(200).json({
      ok,
      claude_cli: cliOk
        ? { ok: true }
        : {
            ok: false,
            message:
              cliResult.status === "fulfilled"
                ? cliResult.value.error ?? "claude --version exited non-zero"
                : errMsg(cliResult.reason),
          },
      openai: embedSkipped
        ? { ok: true, skipped: true }
        : embedResult.status === "fulfilled"
        ? { ok: true }
        : { ok: false, message: errMsg((embedResult as PromiseRejectedResult).reason) },
    });
  });

  return router;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split("\n")[0]!.slice(0, 200);
  }
  return String(err).slice(0, 200);
}
