/**
 * /find-repo REST surface — HTTP wrapper around the `find_repo` MCP
 * tool's ranker so the Capabilities UI can search across all 4 signal
 * sources from a text input.
 *
 *   GET /find-repo?goal=<query>&limit=<1-10>
 *
 * Auth: bv_u_ (human user) only. The caller's primary team agent's id
 * is passed into the ranker so learned-skill matches scope correctly
 * to the caller's owner.
 */
import { Router, type RequestHandler } from "express";
import type {
  AgentRepository,
  EmbeddingService,
  LearnedSkillRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import { createFindRepoTool } from "../tools/find-repo.js";
import { boundedFloorIntQuery, requireStringQuery } from "./query-params.js";

export interface FindRepoRouterDeps {
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  learnedSkillRepo: LearnedSkillRepository;
  embeddings: EmbeddingService;
}

export function createFindRepoRouter(deps: FindRepoRouterDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const goal = requireStringQuery(req, res, "goal", "missing_goal");
    if (!goal) return;
    // The 1..10 band is asserted on both sides of this call — here by
    // `find-repo.test.ts`'s "limit coercion" suite, and again inside
    // `find_repo`'s own handler. Kept rather than deferred to the tool
    // so the route's wire contract stays pinned where it is tested.
    const limit = boundedFloorIntQuery(req, "limit", {
      min: 1,
      max: 10,
      fallback: 5,
    });

    try {
      // The ranker scopes learned_skill lookups to the calling agent's
      // owner. The HTTP caller is a human (bv_u_), so we resolve their
      // primary team agent and use its id. If they have no agent at
      // all, the ranker just gets zero learned-skill matches and the
      // other 3 tiers still work.
      const personId = req.caller!.personId;
      const agent = await deps.agentRepo.findTopLevelForOwner(personId);
      if (!agent) {
        res.status(404).json({ error: "no_agent", message: "Caller has no primary agent." });
        return;
      }

      const tool = createFindRepoTool(
        { agentId: agent.id },
        {
          agentRepo: deps.agentRepo,
          learnedSkillRepo: deps.learnedSkillRepo,
          embeddings: deps.embeddings,
        },
      );
      const result = await tool.handler({ goal, limit });
      if (result.isError) {
        res.status(400).json(result.content);
        return;
      }
      res.status(200).json(result.content);
    } catch (err) {
      console.error("[find-repo/search]", err);
      res.status(500).json({ error: "search_failed" });
    }
  });

  return router;
}
