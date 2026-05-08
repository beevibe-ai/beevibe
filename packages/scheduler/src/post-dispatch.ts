import type {
  AgentRepository,
  Session,
  SessionRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ResumeReason } from "@beevibe/core/services/agent-session";
import type { TaskService } from "@beevibe/core/services/task-service";

/**
 * The XML context marker the retry session sees in its stdin. Identifies
 * the "agent forgot update_progress; please call it now" intent. Exported
 * so tests + the e2e suite can assert the retry session received it.
 */
export const NUDGE_COMPLETION_MARKER = '<context type="nudge_completion">';

export interface PostDispatchDeps {
  taskRepo: TaskRepository;
  taskService: TaskService;
  /**
   * Phase 4: retry sessions go through dispatchService (creates a
   * `pending` row, pins runtime_id to the prior session's daemon so
   * `claude --resume` reads the correct local `.jsonl`). The daemon
   * (or executor as null-runtime fallback) claims and spawns. Inline
   * AgentSession.run is gone from this path.
   */
  dispatchService: DispatchService;
  /**
   * Detect stale post-dispatch invocations: if a newer session has
   * been dispatched for the task between this session's terminal write
   * and the grace window, this post-dispatch is moot — the worker has
   * already re-claimed and the new session owns the task's resolution.
   */
  sessionRepo: SessionRepository;
}

/**
 * Wait for in-flight `update_progress` writes to land before the status
 * check. Aligns with intentcore's 2_000ms grace window.
 */
const GRACE_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * After a task session terminates, decide whether the agent set a final
 * status. Three branches:
 *
 * 1. **Agent set terminal status** → bubble parent rollup via
 *    `taskService.checkAndCompleteParent`.
 * 2. **Still running-status with non-terminal children** → no-op (parent
 *    waiting on children; the agent's exit was intentional).
 * 3. **Still running-status, all children terminal** (parent with mixed
 *    outcomes, not all done) → log a warning + run rollup.
 * 4. **Still running-status, leaf** (no children at all) → dispatch a
 *    retry session pinned to the prior runtime. If the retry also
 *    exits without setting a terminal status, mark the task `failed`.
 *    The retry's terminal write does NOT recurse — its session row
 *    has `prior_session_id` set, so this hook's stale-dispatch guard
 *    catches it (newer-session check on findLatestForTask).
 */
export async function postDispatchCheck(
  deps: PostDispatchDeps,
  taskId: string,
  agentId: string,
  sessionResult: Session,
): Promise<void> {
  await sleep(GRACE_MS);

  const task = await deps.taskRepo.findById(taskId);
  if (!task) return;

  const isRunning =
    task.status === "in_progress" || task.status === "revision";

  if (!isRunning) {
    await deps.taskService.checkAndCompleteParent(taskId);
    return;
  }

  const latest = await deps.sessionRepo.findLatestForTask(taskId);
  if (latest && latest.id !== sessionResult.id) return;

  const [childNotComplete, childTotal] = await Promise.all([
    deps.taskRepo.countChildrenNotComplete(taskId),
    deps.taskRepo.countChildren(taskId),
  ]);
  if (childNotComplete > 0) return;

  if (childTotal > 0) {
    console.warn(
      `[post-dispatch] parent ${taskId} has ${childTotal} all-terminal children; running rollup`,
    );
    await deps.taskService.checkAndCompleteParent(taskId);
    return;
  }

  // Leaf, agent forgot update_progress — re-dispatch with a nudge prompt.
  const retryIntent =
    `<task id="${taskId}"/>\n` +
    `${NUDGE_COMPLETION_MARKER}Your previous session exited without ` +
    `setting a terminal task status. Please call update_progress with ` +
    `done/failed/blocked.</context>`;

  const reason: ResumeReason = {
    kind: "crash_recovery",
    prior_session_id: sessionResult.id,
  };
  await deps.dispatchService.dispatchTask({
    task,
    agentId,
    intent: retryIntent,
    reason,
    type: "task",
  });

  // Wait one more grace window for the daemon (or executor) to claim
  // the retry, run it, and write its terminal state. If the task is
  // STILL non-terminal — two consecutive sessions failed to call
  // update_progress — fail the task so it doesn't sit forever.
  await sleep(GRACE_MS * 30); // 60s — daemon poll cadence + a CLI turn
  const after = await deps.taskRepo.findById(taskId);
  if (
    after &&
    (after.status === "in_progress" || after.status === "revision")
  ) {
    await deps.taskRepo.update(taskId, {
      status: "failed",
      result_summary:
        "Two consecutive sessions exited without calling update_progress.",
    });
  }
}

/**
 * Helper used by the bootstrap hook: given a terminal task session,
 * dispatch the post-dispatch check (parent rollup or leaf retry).
 * The retry path is intentionally fire-and-forget; never blocks the
 * worker's poll cycle.
 */
export interface BuildHookDeps {
  taskRepo: TaskRepository;
  taskService: TaskService;
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  dispatchService: DispatchService;
}

export function buildPostDispatchHook(
  deps: BuildHookDeps,
): (session: Session) => Promise<void> {
  return async (session) => {
    if (session.type !== "task" || !session.task_id) return;

    const agent = await deps.agentRepo.findById(session.agent_id);
    if (!agent) return;

    await postDispatchCheck(
      {
        taskRepo: deps.taskRepo,
        taskService: deps.taskService,
        dispatchService: deps.dispatchService,
        sessionRepo: deps.sessionRepo,
      },
      session.task_id,
      session.agent_id,
      session,
    );
  };
}
