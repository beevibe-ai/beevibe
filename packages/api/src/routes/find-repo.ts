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
import { runToolAsPrimaryAgent } from "./tool-bridge.js";

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

    const goal = typeof req.query.goal === "string" ? req.query.goal.trim() : "";
    if (!goal) {
      res.status(400).json({ error: "missing_goal" });
      return;
    }
    const limitParam = typeof req.query.limit === "string" ? Number(req.query.limit) : 5;
    const limit = Number.isFinite(limitParam) ? Math.min(10, Math.max(1, Math.floor(limitParam))) : 5;

    try {
      // The ranker scopes learned_skill lookups to the calling agent's
      // owner, so this runs as the caller's primary team agent. If they
      // have no agent at all the bridge 404s; a caller who has one but no
      // learned skills just gets zero Tier-2 matches and the other 3
      // tiers still work.
      await runToolAsPrimaryAgent(req, res, deps.agentRepo, {
        makeTool: (agentId) =>
          createFindRepoTool(
            { agentId },
            {
              agentRepo: deps.agentRepo,
              learnedSkillRepo: deps.learnedSkillRepo,
              embeddings: deps.embeddings,
            },
          ),
        input: { goal, limit },
        okStatus: 200,
      });
    } catch (err) {
      console.error("[find-repo/search]", err);
      res.status(500).json({ error: "search_failed" });
    }
  });

  return router;
}
