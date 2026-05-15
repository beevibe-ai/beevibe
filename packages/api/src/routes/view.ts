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
import {
  MEMORY_SCOPES,
  REVIEW_POLICIES,
  isKnownCli,
  type AgentRepository,
  type DaemonRepository,
  type KnownCli,
  type MemoryFactRepository,
  type MemoryScope,
  type ReviewPolicy,
  type RuntimeConfig,
  type RuntimeRepository,
} from "@beevibe/core";
import { requireHuman } from "../auth/middleware.js";
import {
  BlockCharLimitExceededError,
  BlockNotFoundError,
  type CoreMemory,
} from "@beevibe/core/services/memory";
import { listTasks, getTask, type TaskListFilter } from "../views/tasks.js";
import {
  TASK_STATUSES_BY_LIFECYCLE,
  type Lifecycle,
} from "../views/tasks-grouping.js";
import { listAgents, getAgent } from "../views/agents.js";
import { getSessionByShortId, AmbiguousShortIdError } from "../views/sessions.js";
import { listMemoryFactCounts, listMemoryFacts } from "../views/memory.js";
import { getDashboardSummary } from "../views/dashboard.js";
import { getMeshOverview } from "../views/mesh.js";
import { listPromotions } from "../views/promotions.js";
import { listActivity } from "../views/activity.js";
import { getWorkProduct } from "../views/work-product.js";
import { listInbox } from "../views/inbox.js";
import { getAgentNetwork } from "../views/agent-network.js";

export interface ViewRoutesDeps {
  authMiddleware: RequestHandler;
  pool: Pool;
  agentRepo: AgentRepository;
  /** Backs `POST /agent/:id/runtime` (validates runtime exists). */
  runtimeRepo: RuntimeRepository;
  /** Backs `POST /agent/:id/runtime` (cross-tenant guard). */
  daemonRepo: DaemonRepository;
  /** Backs `POST /agent/:id/core-memory/:blockName` (owner block edits). */
  coreMemory: CoreMemory;
  /** Backs `DELETE /memory/fact/:id` (owner-driven memory cleanup). */
  memoryFactRepo: MemoryFactRepository;
}

const LIFECYCLES = new Set<Lifecycle>(
  Object.keys(TASK_STATUSES_BY_LIFECYCLE) as Lifecycle[],
);
const VIEWS = new Set<TaskListFilter["view"]>(["all", "mine", "sprint", "timeline"]);
const SCOPES = new Set<MemoryScope>(MEMORY_SCOPES);

function isReviewPolicy(v: unknown): v is ReviewPolicy {
  return typeof v === "string" && (REVIEW_POLICIES as readonly string[]).includes(v);
}

export function createViewRouter(deps: ViewRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/task", async (req, res) => {
    if (!requireHuman(req, res)) return;

    // Always scope to the caller's owner tree: a task is visible only if
    // the caller owns the assignee agent, owns the creator agent, or
    // created it directly. Without this scope the list leaks tasks across
    // owners (any logged-in person could see every task in the DB).
    const filter: TaskListFilter = { caller_person_id: req.caller.personId };
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

  // IMPORTANT: register `/agent/network` BEFORE `/agent/:id` so Express
  // doesn't match "network" as a path param. Same reason `/agent` (the
  // list) is fine — it's a different path entirely.
  router.get("/agent/network", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      // Cross-owner read: caller's tree plus peer teams from rooms
      // they share. Peer set is derived from room_member co-attendance,
      // which is the explicit consent surface (you're in a room with
      // them, so seeing their team agents isn't a leak).
      const network = await getAgentNetwork(deps.pool, req.caller.personId);
      res.json(network);
    } catch (err) {
      handleError(err, res, "agent network");
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

  router.post("/agent/:id/runtime", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_agent_id" });
      return;
    }
    const body = req.body as { runtime_id?: string | null } | undefined;
    // Allow explicit null to unbind, or a non-empty string to bind.
    const runtimeId =
      body?.runtime_id === null
        ? null
        : typeof body?.runtime_id === "string" && body.runtime_id
          ? body.runtime_id
          : undefined;
    if (runtimeId === undefined) {
      res.status(400).json({
        error: "invalid_body",
        message: "expected { runtime_id: string | null }",
      });
      return;
    }
    try {
      const existing = await deps.agentRepo.findById(id);
      if (!existing) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (existing.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      // Validate the runtime belongs to a daemon owned by the caller.
      // Otherwise a user could re-target their agent at someone else's
      // daemon (cross-tenant escalation).
      let cliToSync: KnownCli | undefined;
      if (runtimeId !== null) {
        const runtime = await deps.runtimeRepo.findById(runtimeId);
        if (!runtime) {
          res.status(404).json({ error: "runtime_not_found" });
          return;
        }
        const daemon = await deps.daemonRepo.findById(runtime.daemon_id);
        if (!daemon || daemon.owner_person_id !== req.caller.personId) {
          res.status(403).json({ error: "runtime_not_owned" });
          return;
        }
        // Daemon registration filters to KNOWN_CLIS, so this should always
        // pass — defensive check guards against drift in older daemons.
        if (!isKnownCli(runtime.cli)) {
          res.status(409).json({
            error: "unknown_runtime_cli",
            message: `Runtime advertises CLI '${runtime.cli}' which beevibe does not support yet.`,
          });
          return;
        }
        cliToSync = runtime.cli;
      }
      // Sync runtime_config.type with the bound runtime's CLI so the
      // registry lookup (LocalWorkspaceManager / room mesh-spawn) hits the
      // right adapter. Preserve every other field (model, max_turns, …).
      // Unbind (runtimeId=null) leaves the type alone — the agent's CLI
      // preference doesn't change just because no daemon is pinned.
      const patch: { preferred_runtime_id: string | undefined; runtime_config?: RuntimeConfig } = {
        preferred_runtime_id: runtimeId as string | undefined,
      };
      if (cliToSync && existing.runtime_config.type !== cliToSync) {
        patch.runtime_config = { ...existing.runtime_config, type: cliToSync };
      }
      const updated = await deps.agentRepo.update(id, patch);
      res.json({
        ok: true,
        preferred_runtime_id: updated.preferred_runtime_id ?? null,
        runtime_config_type: updated.runtime_config.type,
      });
    } catch (err) {
      handleError(err, res, "agent runtime update");
    }
  });

  router.post("/agent/:id/model", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_agent_id" });
      return;
    }
    const body = req.body as { model?: string | null } | undefined;
    // null clears (agent uses CLI default), non-empty string sets.
    const model =
      body?.model === null
        ? null
        : typeof body?.model === "string" && body.model
          ? body.model
          : undefined;
    if (model === undefined) {
      res.status(400).json({
        error: "invalid_body",
        message: "expected { model: string | null }",
      });
      return;
    }
    try {
      const existing = await deps.agentRepo.findById(id);
      if (!existing) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (existing.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      // Build the next runtime_config: keep the existing fields, override
      // (or remove) just the `model` key. Don't replace the whole config
      // wholesale — type / max_turns / etc. should survive.
      const nextRuntimeConfig = { ...existing.runtime_config };
      if (model === null) {
        delete nextRuntimeConfig.model;
      } else {
        nextRuntimeConfig.model = model;
      }
      const updated = await deps.agentRepo.update(id, {
        runtime_config: nextRuntimeConfig,
      });
      res.json({
        ok: true,
        model: updated.runtime_config.model ?? null,
      });
    } catch (err) {
      handleError(err, res, "agent model update");
    }
  });

  router.post("/agent/:id/review-policy", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_agent_id" });
      return;
    }
    const body = req.body as { review_policy?: unknown } | undefined;
    const policy = body?.review_policy;
    if (!isReviewPolicy(policy)) {
      res.status(400).json({
        error: "invalid_body",
        message: `expected { review_policy: ${REVIEW_POLICIES.map((p) => `"${p}"`).join(" | ")} }`,
      });
      return;
    }
    try {
      const existing = await deps.agentRepo.findById(id);
      if (!existing) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (existing.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      const updated = await deps.agentRepo.update(id, { review_policy: policy });
      res.json({ ok: true, review_policy: updated.review_policy });
    } catch (err) {
      handleError(err, res, "agent review_policy update");
    }
  });

  router.post("/agent/:id/core-memory/:blockName", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    const blockName = req.params.blockName;
    if (!id || !blockName) {
      res.status(400).json({ error: "missing_param" });
      return;
    }
    const body = req.body as { content?: unknown } | undefined;
    if (typeof body?.content !== "string") {
      res.status(400).json({
        error: "invalid_body",
        message: "expected { content: string }",
      });
      return;
    }
    try {
      const existing = await deps.agentRepo.findById(id);
      if (!existing) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (existing.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      await deps.coreMemory.setContent(id, blockName, body.content);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof BlockNotFoundError) {
        res.status(404).json({ error: "block_not_found", message: err.message });
        return;
      }
      if (err instanceof BlockCharLimitExceededError) {
        res.status(400).json({ error: "char_limit_exceeded", message: err.message });
        return;
      }
      handleError(err, res, "agent core_memory update");
    }
  });

  router.post("/agent/:id/archive", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_agent_id" });
      return;
    }
    try {
      const existing = await deps.agentRepo.findById(id);
      if (!existing) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      if (existing.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      if (existing.archived_at) {
        res.json({ ok: true, archived_at: existing.archived_at.toISOString() });
        return;
      }
      const updated = await deps.agentRepo.update(id, { archived_at: new Date() });
      res.json({ ok: true, archived_at: updated.archived_at!.toISOString() });
    } catch (err) {
      handleError(err, res, "agent archive");
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

  router.get("/memory/fact/counts", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const counts = await listMemoryFactCounts(deps.pool, req.caller.personId);
      res.json(counts);
    } catch (err) {
      handleError(err, res, "memory fact counts");
    }
  });

  router.delete("/memory/fact/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_fact_id" });
      return;
    }
    try {
      const fact = await deps.memoryFactRepo.findById(id);
      if (!fact) {
        res.status(404).json({ error: "fact_not_found" });
        return;
      }
      // Ownership lives on the agent, not the fact — load the agent and
      // verify owner_id. memory_fact.agent_id is NOT NULL with ON DELETE
      // CASCADE (initial schema), so the agent is guaranteed to exist
      // here. Matches the read-side filter in listMemoryFacts.
      const agent = await deps.agentRepo.findById(fact.agent_id);
      if (!agent || agent.owner_id !== req.caller.personId) {
        res.status(403).json({ error: "not_owner" });
        return;
      }
      await deps.memoryFactRepo.delete(id);
      // DELETE trigger on memory_fact fires `memory.fact.deleted` SSE
      // (migration 1780600000000) → web invalidates the memory list.
      res.json({ ok: true, fact_id: id });
    } catch (err) {
      handleError(err, res, "memory fact delete");
    }
  });

  router.get("/work-product/:id", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_work_product_id" });
      return;
    }
    try {
      const wp = await getWorkProduct(deps.pool, id);
      if (!wp) {
        res.status(404).json({ error: "work_product_not_found" });
        return;
      }
      res.json(wp);
    } catch (err) {
      handleError(err, res, "work product detail");
    }
  });

  router.get("/inbox", async (req, res) => {
    if (!requireHuman(req, res)) return;
    try {
      const limitParam = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;
      const items = await listInbox(deps.pool, req.caller.personId, { limit });
      res.json(items);
    } catch (err) {
      handleError(err, res, "inbox");
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
