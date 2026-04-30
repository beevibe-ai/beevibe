/**
 * Human-facing task review routes (M6.4). All require bv_u_ caller.
 *
 *   POST /task/:id/approve   { result_summary?: string }
 *   POST /task/:id/reject    { result_summary?: string }
 *   POST /task/:id/revise    { feedback: string }
 *   POST /task/:id/cancel    { reason?: string }
 *
 * approve/reject/revise are the M6.4 split of the old M5 approveTask
 * 3-way method. Cancel is the in-flight kill (pg_notify('cancel_task',
 * task_id) signal handed to the executor's cancel-listener).
 *
 * Latency budget:
 *   - approve / reject / revise: 0–30s end-to-end (DB write here, then
 *     executor's next poll picks up needs_revision via listAssignable;
 *     done/cancelled are terminal so no further work).
 *   - cancel: <200ms target end-to-end (DB write + pg_notify; executor
 *     receives notification; AbortController fires; CLI subprocess
 *     killed).
 */

import { Router, type RequestHandler, type Response } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type { TaskRepository, TaskStatus } from "@beevibe/core";
import {
  type TaskService,
  InvalidTaskTransitionError,
  TaskNotFoundError,
} from "@beevibe/core/services/task-service";
import { requireHuman } from "../auth/middleware.js";

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
  /** For pg_notify('cancel_task', task_id). */
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

export function createTaskRouter(deps: TaskRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

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
      res.json({
        ok: true,
        task: {
          id: updated.id,
          status: updated.status,
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

      // pg_notify the executor's cancel-listener so the in-flight CLI
      // subprocess (if any) gets killed via AbortController.
      await deps.pool.query(`SELECT pg_notify('cancel_task', $1)`, [id]);

      res.json({
        ok: true,
        task_id: id,
        note: "cancellation signal sent to executor; CLI subprocess will be killed if running",
      });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
