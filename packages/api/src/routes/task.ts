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

import { Router, type RequestHandler } from "express";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  TASK_PRIORITIES,
  isInFlightSessionStatus,
  taskId,
  type RepoRunRepository,
  type RuntimeRepository,
  type SessionRepository,
  type SkillOutcomeRepository,
  type SkillOutcomeValue,
  type TaskRepository,
  type TaskPriority,
  type TaskStatus,
  type WorkProductRepository,
} from "@beevibe/core";
import { newSkillOutcomeId } from "@beevibe/core/adapters/postgres";
import {
  type TaskService,
  InvalidTaskTransitionError,
  TaskNotFoundError,
} from "@beevibe/core/services/task-service";
import { buildIntent, type ResumeReason } from "@beevibe/core/services/agent-session";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { requireHuman } from "../auth/middleware.js";
import type { DaemonHub } from "../runtime/hub.js";
import { makeServiceErrorHandler, requireParam } from "./http-errors.js";

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
  /**
   * Capability Network: optional — when present, capability outcomes are
   * recorded after approve/reject/revise so the discovery ranker stays
   * accurate. Omitting them (e.g. in tests) disables outcome recording.
   */
  workProductRepo?: WorkProductRepository;
  repoRunRepo?: RepoRunRepository;
  skillOutcomeRepo?: SkillOutcomeRepository;
}

/**
 * Fire-and-forget helper: find any capability artifacts on the task
 * whose source learned_skill has an id, then record the outcome.
 */
async function recordCapabilityOutcome(
  taskId: string,
  outcome: SkillOutcomeValue,
  reviewerId: string,
  deps: Pick<TaskRoutesDeps, "workProductRepo" | "repoRunRepo" | "skillOutcomeRepo">,
): Promise<void> {
  if (!deps.workProductRepo || !deps.repoRunRepo || !deps.skillOutcomeRepo) return;
  try {
    const wps = await deps.workProductRepo.listByTask(taskId);
    for (const wp of wps) {
      if (wp.type !== "artifact") continue;
      const repoRunId = (wp.metadata as Record<string, unknown> | undefined)?.repo_run_id;
      if (typeof repoRunId !== "string") continue;
      const run = await deps.repoRunRepo.findById(repoRunId);
      if (!run?.learned_skill_id) continue;
      await deps.skillOutcomeRepo.upsert({
        id: newSkillOutcomeId(),
        learned_skill_id: run.learned_skill_id,
        repo_run_id: run.id,
        work_product_id: wp.id,
        outcome,
        reviewer_id: reviewerId,
      });
    }
  } catch (err) {
    // Outcome recording is best-effort — don't fail the review action.
    console.warn("[task route] capability outcome recording failed:", err instanceof Error ? err.message : String(err));
  }
}

const handleServiceError = makeServiceErrorHandler("task route", [
  { error: TaskNotFoundError, status: 404, code: "task_not_found" },
  { error: InvalidTaskTransitionError, status: 409, code: "invalid_transition" },
]);

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
    const id = requireParam(req, res, "id", "missing_task_id");
    if (!id) return;
    try {
      const summary =
        typeof req.body?.result_summary === "string"
          ? req.body.result_summary
          : undefined;
      const updated = await deps.taskService.approveTask(id, summary);
      void recordCapabilityOutcome(id, "approved", req.caller!.personId, deps);
      res.json({ ok: true, task: { id: updated.id, status: updated.status } });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/reject
  router.post("/:id/reject", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_task_id");
    if (!id) return;
    try {
      const summary =
        typeof req.body?.result_summary === "string"
          ? req.body.result_summary
          : undefined;
      const updated = await deps.taskService.rejectTask(id, summary);
      void recordCapabilityOutcome(id, "rejected", req.caller!.personId, deps);
      res.json({ ok: true, task: { id: updated.id, status: updated.status } });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/revise
  router.post("/:id/revise", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_task_id");
    if (!id) return;
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
      void recordCapabilityOutcome(id, "revised", req.caller!.personId, deps);

      // Mirror the parent_agent revise_task MCP tool path
      // (hierarchy.ts:824-840): reviseTask just stamps the task with
      // status='needs_revision' + next_dispatch_context. Without an
      // explicit dispatch, no session row exists and no daemon claims
      // the task — it sits at needs_revision until manual intervention.
      // The MCP tool dispatched; this route forgot to.
      //
      // Post-#186: the task stays at 'needs_revision' until the daemon
      // actually claims the dispatched session — `transitionTaskOnClaim`
      // does the flip to 'revision' at claim time, not here.
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
      }

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

  // POST /task/:id/retry
  router.post("/:id/retry", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_task_id");
    if (!id) return;
    try {
      const { task, assigneeId, priorSessionId } =
        await deps.taskService.prepareRetry(id);
      const reason: ResumeReason = priorSessionId
        ? { kind: "crash_recovery", prior_session_id: priorSessionId }
        : { kind: "fresh" };
      const intent = buildIntent(
        { id: task.id, title: task.title, description: task.description },
        reason,
      );
      await deps.dispatchService.dispatchTask({
        task,
        agentId: assigneeId,
        intent,
        reason,
        type: "task",
      });
      res.json({ ok: true, task: { id: task.id, status: task.status } });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // POST /task/:id/cancel
  router.post("/:id/cancel", async (req, res) => {
    if (!requireHuman(req, res)) return;
    const id = requireParam(req, res, "id", "missing_task_id");
    if (!id) return;
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

      // Pending sessions have no CLI to abort — they're just DB rows
      // waiting for a daemon to claim. Flip them straight to cancelled
      // so the SQL claim gate stops returning them. Running sessions
      // are handled by the WS push / pg_notify path below; their
      // session.status flip is written by /runtime/done on CLI exit.
      await deps.sessionRepo.cancelPendingForTask(id);

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
