/**
 * Read-only view routes (M8.2). All require `bv_u_` Bearer.
 *
 *   GET /task                    list, query: lifecycle?, assignee_id?, view?
 *   GET /task/:id                detail (work_products, sessions joined)
 *   GET /agent                   list
 *   GET /agent/:id               detail (core_blocks, metrics, recent_sessions, mesh hints)
 *   GET /session/:short_id       detail (briefing/transcript stubbed for now)
 *   GET /memory/fact             list, query: scope?, owner-scoped
 *
 * Design:
 *   - Each handler wraps a `views/*.ts` composer that talks pg directly.
 *   - "mine" view-shortcut needs the caller's primary agent — resolved here
 *     via AgentRepository, then passed to listTasks as `assignee_id`.
 *   - 404 for missing detail rows; 409 for ambiguous session short_id.
 *
 * The router intentionally does NOT mount under `/api/...` (web's earlier
 * guess); it matches M6's singular-noun, no-prefix style (`/task/:id/...`).
 */

import { Router, type RequestHandler } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { MEMORY_SCOPES, type AgentRepository, type MemoryScope } from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import { listTasks, getTask, type TaskListFilter } from "../views/tasks.js";
import {
  TASK_STATUSES_BY_LIFECYCLE,
  type Lifecycle,
} from "../views/tasks-grouping.js";
import { listAgents, getAgent } from "../views/agents.js";
import { getSessionByShortId, AmbiguousShortIdError } from "../views/sessions.js";
import { listMemoryFacts } from "../views/memory.js";
import { getDashboardSummary } from "../views/dashboard.js";
import { getMeshOverview } from "../views/mesh.js";
import { listPromotions } from "../views/promotions.js";
import { listActivity } from "../views/activity.js";

export interface ViewRoutesDeps {
  authMiddleware: RequestHandler;
  pool: Pool;
  agentRepo: AgentRepository;
}

const LIFECYCLES = new Set<Lifecycle>(
  Object.keys(TASK_STATUSES_BY_LIFECYCLE) as Lifecycle[],
);
const VIEWS = new Set<TaskListFilter["view"]>(["all", "mine", "sprint", "timeline"]);
const SCOPES = new Set<MemoryScope>(MEMORY_SCOPES);

export function createViewRouter(deps: ViewRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/task", async (req, res) => {
    if (!requireHuman(req, res)) return;

    const filter: TaskListFilter = {};
    const lifecycleParam = typeof req.query.lifecycle === "string" ? req.query.lifecycle : undefined;
    if (lifecycleParam && LIFECYCLES.has(lifecycleParam as Lifecycle)) {
      filter.lifecycle = lifecycleParam as Lifecycle;
    }
    const viewParam = typeof req.query.view === "string" ? req.query.view : undefined;
    if (viewParam && VIEWS.has(viewParam as TaskListFilter["view"])) {
      filter.view = viewParam as TaskListFilter["view"];
    }

    if (filter.view === "mine") {
      // Resolve the caller to their primary agent so "mine" filters tasks
      // assigned to that agent. Top-level (team or org) — IC agents are
      // subordinates, not the caller's primary identity.
      const primary = await deps.agentRepo.findTopLevelForOwner(req.caller.personId);
      if (primary) filter.assignee_id = primary.id;
      else {
        // No agent → no tasks; short-circuit.
        res.json([]);
        return;
      }
    } else if (typeof req.query.assignee_id === "string") {
      filter.assignee_id = req.query.assignee_id;
    }

    try {
      const tasks = await listTasks(deps.pool, filter);
      res.json(tasks);
    } catch (err) {
      handleError(err, res, "task list");
    }
  });

  router.get("/task/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }
    try {
      const task = await getTask(deps.pool, id);
      if (!task) {
        res.status(404).json({ error: "task_not_found" });
        return;
      }
      res.json(task);
    } catch (err) {
      handleError(err, res, "task detail");
    }
  });

  router.get("/agent", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      // Scope to the caller's tree (their team agent + its IC subordinates).
      // The list power-user feature ("show me everyone's agents") isn't
      // wired today; scoping by default also closes the same multi-tenant
      // leak the SSE filter closed in OwnerLookup.
      const agents = await listAgents(deps.pool, req.caller.personId);
      res.json(agents);
    } catch (err) {
      handleError(err, res, "agent list");
    }
  });

  router.get("/agent/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_agent_id" });
      return;
    }
    try {
      const agent = await getAgent(deps.pool, id);
      if (!agent) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      res.json(agent);
    } catch (err) {
      handleError(err, res, "agent detail");
    }
  });

  router.get("/session/:shortId", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const shortId = req.params.shortId;
    if (!shortId) {
      res.status(400).json({ error: "missing_short_id" });
      return;
    }
    try {
      const session = await getSessionByShortId(deps.pool, shortId);
      if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      res.json(session);
    } catch (err) {
      if (err instanceof AmbiguousShortIdError) {
        res.status(409).json({
          error: "ambiguous_short_id",
          message: err.message,
        });
        return;
      }
      handleError(err, res, "session detail");
    }
  });

  router.get("/dashboard", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const summary = await getDashboardSummary(deps.pool);
      res.json(summary);
    } catch (err) {
      handleError(err, res, "dashboard summary");
    }
  });

  router.get("/mesh", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const overview = await getMeshOverview(deps.pool);
      res.json(overview);
    } catch (err) {
      handleError(err, res, "mesh overview");
    }
  });

  router.get("/promotion", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    try {
      const events = await listPromotions(deps.pool, req.caller.personId, { limit });
      res.json(events);
    } catch (err) {
      handleError(err, res, "promotion list");
    }
  });

  router.get("/memory/fact", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const scopeParam = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const scope =
      scopeParam && SCOPES.has(scopeParam as MemoryScope)
        ? (scopeParam as MemoryScope)
        : undefined;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    try {
      const facts = await listMemoryFacts(deps.pool, req.caller.personId, {
        scope,
        limit,
      });
      res.json(facts);
    } catch (err) {
      handleError(err, res, "memory fact list");
    }
  });

  router.get("/activity", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const limitParam =
        typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
      const limit =
        Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 100
          ? limitParam
          : 20;
      const entries = await listActivity(deps.pool, req.caller.personId, limit);
      res.json(entries);
    } catch (err) {
      handleError(err, res, "activity feed");
    }
  });

  return router;
}

function handleError(err: unknown, res: import("express").Response, context: string): void {
  console.error(`[view route: ${context}]`, err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}
