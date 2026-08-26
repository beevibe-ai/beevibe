/**
 * /capabilities REST surface — UI-driven persistence for the Capability
 * Network. Companion to /find-repo (discovery) and /learned-skills (post-
 * sandbox-run registry).
 *
 *   GET  /capabilities/referenced-repos?task_id=...
 *        List GitHub repos the agent referenced inside a closed task.
 *        Used by the "Save as team capability" card on task detail.
 *
 *   POST /capabilities/use            { repo_url, goal, task_id? }
 *        Kick off a `use_repo` sandbox run on behalf of a human caller —
 *        mirrors what the MCP tool does for agents. Returns immediately
 *        with { repo_run_id, watch_url } so the UI can link to the live
 *        transcript.
 *
 * Auth: bv_u_ (human) only.
 */
import { Router, type RequestHandler } from "express";
import type {
  AgentRepository,
  LearnedSkillRepository,
  RepoRunRepository,
  SessionEventRepository,
  SessionRepository,
  TaskRepository,
  WorkProductRepository,
} from "@beevibe/core";
import { getReferencedRepos } from "@beevibe/core/services/referenced-repos";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { requireHuman } from "../auth/middleware.js";
import { runToolAsPrimaryAgent } from "./agent-tool-bridge.js";
import { readStringQuery } from "./http-errors.js";
import { createUseRepoTool } from "../tools/use-repo.js";

export interface CapabilitiesRouterDeps {
  authMiddleware: RequestHandler;
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workProductRepo: WorkProductRepository;
  repoRunRepo: RepoRunRepository;
  learnedSkillRepo: LearnedSkillRepository;
  dispatchService: DispatchService;
}

export function createCapabilitiesRouter(deps: CapabilitiesRouterDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // GET /capabilities/referenced-repos?task_id=...
  router.get("/referenced-repos", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const taskIdParam = readStringQuery(req, "task_id");
    if (!taskIdParam) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }

    try {
      // Confirm the task exists and belongs to the caller before we
      // scan its transcript — otherwise any user could mine any task.
      const task = await deps.taskRepo.findById(taskIdParam);
      if (!task) {
        res.status(404).json({ error: "task_not_found" });
        return;
      }
      const personId = req.caller!.personId;
      // The task is reachable if the caller created it; tighter ACL
      // (agents on the user's team) is enforced separately by the
      // /task/:id/view surface.
      if (task.creator_id !== personId && task.creator_type !== "agent") {
        // Agent-created tasks are fine — they're owned by an agent the
        // caller controls. Direct task creation by another human is not.
        const agent = await deps.agentRepo.findById(task.creator_id);
        if (!agent || agent.owner_id !== personId) {
          res.status(403).json({ error: "not_owner" });
          return;
        }
      }

      const repos = await getReferencedRepos(taskIdParam, personId, {
        sessionRepo: deps.sessionRepo,
        sessionEventRepo: deps.sessionEventRepo,
        workProductRepo: deps.workProductRepo,
        learnedSkillRepo: deps.learnedSkillRepo,
      });
      res.status(200).json({ repos });
    } catch (err) {
      console.error("[capabilities/referenced-repos]", err);
      res.status(500).json({ error: "scan_failed" });
    }
  });

  // POST /capabilities/use — trigger a use_repo sandbox run.
  router.post("/use", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const body = req.body as Partial<{ repo_url: string; goal: string }>;
    const repoUrl = typeof body.repo_url === "string" ? body.repo_url.trim() : "";
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!repoUrl) {
      res.status(400).json({ error: "missing_repo_url" });
      return;
    }
    if (!goal) {
      res.status(400).json({ error: "missing_goal" });
      return;
    }

    try {
      // The resulting container task + repo_run + work_product are owned
      // by the caller's team agent, which matches the agent-driven flow.
      await runToolAsPrimaryAgent({
        res,
        personId: req.caller!.personId,
        agentRepo: deps.agentRepo,
        makeTool: (agentId) =>
          createUseRepoTool(
            { agentId },
            {
              agentRepo: deps.agentRepo,
              taskRepo: deps.taskRepo,
              repoRunRepo: deps.repoRunRepo,
              dispatchService: deps.dispatchService,
            },
          ),
        input: { goal, repo_url: repoUrl },
        successStatus: 202,
      });
    } catch (err) {
      console.error("[capabilities/use]", err);
      res.status(500).json({ error: "use_failed" });
    }
  });

  return router;
}
