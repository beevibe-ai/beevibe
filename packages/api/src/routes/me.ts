/**
 * Onboarding/identity surface for the human chat client.
 *
 * - `GET /me` — returns the caller's person + their primary agent + a
 *   `needs_onboarding` flag so the web's `/welcome` route can decide
 *   whether to redirect into the wizard or pass through to chat.
 * - `POST /me/onboarding/complete` — flips `person.onboarding_completed_at`
 *   so the wizard exit cannot trap the user. Idempotent.
 * - `GET /health/llm` — runs a tiny call against each LLM/embedding
 *   provider so the welcome wizard can show a green-light "providers
 *   reachable" check before letting the user enter chat.
 */

import { Router, type RequestHandler } from "express";
import type {
  AgentRepository,
  EmbeddingService,
  LlmProvider,
  PersonRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";

export interface MeRoutesDeps {
  authMiddleware: RequestHandler;
  personRepo: PersonRepository;
  agentRepo: AgentRepository;
  llm: LlmProvider;
  embed: EmbeddingService;
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

  router.get("/health/llm", async (req, res) => {
    if (!requireHuman(req, res)) return;
    // Run both checks in parallel; report each independently so the UI can
    // tell the user which provider is broken (tutorial bug surface vs.
    // upstream outage).
    const [llmResult, embedResult] = await Promise.allSettled([
      deps.llm.complete({
        system: "You are a health probe.",
        prompt: "ok",
        maxTokens: 1,
      }),
      deps.embed.embed("ok"),
    ]);

    const ok = llmResult.status === "fulfilled" && embedResult.status === "fulfilled";
    res.status(ok ? 200 : 503).json({
      ok,
      anthropic: llmResult.status === "fulfilled"
        ? { ok: true }
        : { ok: false, message: errMsg(llmResult.reason) },
      openai: embedResult.status === "fulfilled"
        ? { ok: true }
        : { ok: false, message: errMsg(embedResult.reason) },
    });
  });

  return router;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    // Surface only the first line — provider SDKs often dump full stacks.
    return err.message.split("\n")[0]!.slice(0, 200);
  }
  return String(err).slice(0, 200);
}
