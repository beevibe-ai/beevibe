/**
 * Human-facing task routes. All require bv_u_ caller.
 *
 *   POST /task                     { title, description?, priority?, assignee_id?, parent_task_id? }
 *   POST /task/:id/approve         { result_summary? }
 *   POST /task/:id/reject          { result_summary? }
 *   POST /task/:id/revise          { feedback }
 *   POST /task/:id/cancel          { reason? }
 *
 * Latency budget:
 *   - approve / reject / revise / create: 0–30s end-to-end (DB write here,
 *     then executor's next poll picks up assignable tasks via listAssignable;
 *     done/cancelled are terminal so no further work).
 *   - cancel: <200ms target end-to-end (DB write + pg_notify; executor
 *     receives notification; AbortController fires; CLI subprocess
 *     killed).
 */

import { Router, type RequestHandler, type Response } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  TASK_PRIORITIES,
  isInFlightSessionStatus,
  taskId,
  type RuntimeRepository,
  type SessionRepository,
  type TaskRepository,
  type TaskPriority,
  type TaskStatus,
} from "@beevibe/core";
import {
  type TaskService,
  InvalidTaskTransitionError,
  TaskNotFoundError,
} from "@beevibe/core/services/task-service";
import { buildIntent, type ResumeReason } from "@beevibe/core/services/agent-session";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { requireHuman } from "../auth/middleware.js";
import type { DaemonHub } from "../runtime/hub.js";

/** Statuses from which /cancel is legal. Anything non-terminal. */
const CANCELLABLE_FROM: readonly TaskStatus[] = [
  "pending",
  "assigned",
  "needs_revision",
  "in_progress",
  "revision",
  "review",
  "blocked",
];

export interface TaskRoutesDeps {
  authMiddleware: RequestHandler;
  taskRepo: TaskRepository;
  taskService: TaskService;
  sessionRepo: SessionRepository;
  runtimeRepo: RuntimeRepository;
  /**
   * Required to dispatch the revision session after `POST /task/:id/revise`.
   * Without it, the task lands at `needs_revision` and just sits — no
   * session row exists for the daemon to claim.
   */
  dispatchService: DispatchService;
  /** Push cancel frames over WS to daemon-bound running sessions. */
  hub: DaemonHub;
  /** For pg_notify('cancel_task', task_id) — server-fallback path only. */
  pool: Pool;
}

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof TaskNotFoundError) {
    res.status(404).json({ error: "task_not_found", message: err.message });
    return;
  }
  if (err instanceof InvalidTaskTransitionError) {
    res.status(409).json({ error: "invalid_transition", message: err.message });
    return;
  }
  console.error("[task route]", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

function parsePriority(input: unknown): TaskPriority | undefined {
  if (typeof input !== "string") return undefined;
  return (TASK_PRIORITIES as readonly string[]).includes(input)
    ? (input as TaskPriority)
    : undefined;
}

export function createTaskRouter(deps: TaskRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  // POST /task
  router.post("/", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      res.status(400).json({
        error: "title_required",
        message: "POST body must include a non-empty `title: string`",
      });
      return;
    }

    const priorityRaw = body.priority;
    const priority = parsePriority(priorityRaw);
    if (priorityRaw !== undefined && priority === undefined) {
      res.status(400).json({
        error: "invalid_priority",
        message: `priority must be one of ${TASK_PRIORITIES.join(", ")}`,
      });
      return;
    }

    try {
      const created = await deps.taskRepo.create({
        id: taskId(),
        title: body.title,
        description: typeof body.description === "string" ? body.description : undefined,
        status: "pending",
        priority: priority ?? "medium",
        assignee_id:
          typeof body.assignee_id === "string" ? body.assignee_id : undefined,
        creator_id: req.caller.personId,
        creator_type: "person",
        parent_task_id:
          typeof body.parent_task_id === "string" ? body.parent_task_id : undefined,
      });
      res.status(201).json({ ok: true, task: created });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/approve
  router.post("/:id/approve", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }
    try {
      const summary =
        typeof req.body?.result_summary === "string"
          ? req.body.result_summary
          : undefined;
      const updated = await deps.taskService.approveTask(id, summary);
      res.json({ ok: true, task: { id: updated.id, status: updated.status } });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/reject
  router.post("/:id/reject", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }
    try {
      const summary =
        typeof req.body?.result_summary === "string"
          ? req.body.result_summary
          : undefined;
      const updated = await deps.taskService.rejectTask(id, summary);
      res.json({ ok: true, task: { id: updated.id, status: updated.status } });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/revise
  router.post("/:id/revise", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }
    const feedback = typeof req.body?.feedback === "string" ? req.body.feedback : "";
    if (!feedback) {
      res.status(400).json({
        error: "feedback_required",
        message: "POST body must include `feedback: string`",
      });
      return;
    }
    try {
      const updated = await deps.taskService.reviseTask(id, feedback, {
        source: "human",
      });

      // Mirror the parent_agent revise_task MCP tool path
      // (hierarchy.ts:824-840): reviseTask just stamps the task with
      // status='needs_revision' + next_dispatch_context. Without an
      // explicit dispatch, no session row exists and no daemon claims
      // the task — it sits at needs_revision until manual intervention.
      // The MCP tool dispatched; this route forgot to.
      let dispatchedStatus: TaskStatus = updated.status;
      if (updated.next_dispatch_context?.kind === "revision" && updated.assignee_id) {
        const reason: ResumeReason = updated.next_dispatch_context;
        const intent = buildIntent(
          { id: updated.id, title: updated.title, description: updated.description },
          reason,
        );
        await deps.dispatchService.dispatchTask({
          task: updated,
          agentId: updated.assignee_id,
          intent,
          reason,
          type: "task",
        });
        // dispatchService transitions needs_revision → revision and
        // inserts a pending session pinned to the agent's runtime.
        dispatchedStatus = "revision";
      }

      res.json({
        ok: true,
        task: {
          id: updated.id,
          status: dispatchedStatus,
          next_dispatch_context: updated.next_dispatch_context,
        },
      });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/cancel
  router.post("/:id/cancel", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: "missing_task_id" });
      return;
    }
    try {
      const task = await deps.taskRepo.findById(id);
      if (!task) {
        res.status(404).json({ error: "task_not_found" });
        return;
      }
      if (!CANCELLABLE_FROM.includes(task.status)) {
        res.status(409).json({
          error: "invalid_transition",
          message: `cannot cancel task in status '${task.status}' — already terminal`,
        });
        return;
      }

      const reason =
        typeof req.body?.reason === "string"
          ? `cancelled by ${req.caller.personId}: ${req.body.reason}`
          : `cancelled by ${req.caller.personId}`;

      // CANCELLABLE_FROM gate above already rejects terminal states, so
      // this UPDATE only runs against non-terminal tasks.
      await deps.taskRepo.update(id, {
        status: "cancelled",
        result_summary: reason,
      });

      // Route the cancel signal to whichever path is running the work:
      // - Daemon-bound sessions: push `{type:"cancel"}` over WS via
      //   DaemonHub. The daemon's claimer.ts handles the frame and
      //   aborts the subprocess via Supervisor → AbortController → SIGTERM.
      // - Server-fallback (in-process) sessions: pg_notify the
      //   scheduler's CancelListener, which aborts the in-process spawn.
      // We fire both — pg_notify is cheap and the daemon doesn't listen
      // on it. Each path is a no-op for sessions running on the other.
      const sessions = await deps.sessionRepo.listForTask(id);
      const cancelPushes: Array<Promise<void>> = [];
      for (const s of sessions) {
        if (!isInFlightSessionStatus(s.status)) continue;
        if (!s.runtime_id) continue;
        cancelPushes.push(
          deps.runtimeRepo.findById(s.runtime_id).then((rt) => {
            if (rt) deps.hub.cancel(rt.daemon_id, s.id);
          }),
        );
      }
      await Promise.all(cancelPushes);
      await deps.pool.query(`SELECT pg_notify('cancel_task', $1)`, [id]);

      res.json({
        ok: true,
        task_id: id,
        note: "cancellation signal sent to daemon (WS) and scheduler (pg_notify); CLI subprocess will be killed if running",
      });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
