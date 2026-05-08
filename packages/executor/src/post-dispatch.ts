import type {
  Agent,
  AgentRepository,
  RuntimeRegistry,
  Session,
  SessionEventRepository,
  SessionRepository,
  TaskRepository,
  Workspace,
  WorkspaceManager,
} from "@beevibe/core";
import { AgentSession } from "@beevibe/core/services/agent-session";
import type { MemoryAgent } from "@beevibe/core/services/memory";
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
  agentSession: AgentSession;
  /**
   * Used to detect stale post-dispatch invocations: if a newer session has
   * been dispatched for the task between this session's terminal write and
   * the grace window, this post-dispatch is moot — the worker has already
   * re-claimed and the new session owns the task's resolution. Skipping
   * here avoids spurious retries that race the worker's actual re-dispatch.
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
 *    outcomes, not all done) → log a warning + run rollup. Per M6 plan
 *    note 27: M6 doesn't auto-fail parents with failed children.
 *    `checkAndCompleteParent` only marks parent done if all children are
 *    in {done, cancelled, failed}; mixed outcomes flow through but log so
 *    operators see them.
 * 4. **Still running-status, leaf** (no children at all) → retry the
 *    session once with a nudge-completion intent. If the retry also exits
 *    without setting a terminal status, mark the task `failed`.
 *
 * Wired via `AgentSession.onSessionComplete` (fire-and-forget) — never
 * blocks the worker's poll cycle. The retry is launched directly via
 * `agentSession.run` with `skipOnComplete: true` to break recursion.
 */
export async function postDispatchCheck(
  deps: PostDispatchDeps,
  taskId: string,
  agentId: string,
  workspace: Workspace,
  sessionResult: Session,
): Promise<void> {
  await sleep(GRACE_MS);

  const task = await deps.taskRepo.findById(taskId);
  if (!task) return;

  const isRunning =
    task.status === "in_progress" || task.status === "revision";

  if (!isRunning) {
    // Agent set terminal status — bubble parent rollup if applicable.
    await deps.taskService.checkAndCompleteParent(taskId);
    return;
  }

  // Stale-dispatch guard: if a newer session has been spawned for this task
  // since the one we're checking on, the worker has already re-claimed and
  // dispatched. This post-dispatch is moot — its retry would race the
  // worker's real re-dispatch and the two concurrent sessions corrupt
  // task state. The newer session's own post-dispatch will handle retry
  // if needed.
  const latest = await deps.sessionRepo.findLatestForTask(taskId);
  if (latest && latest.id !== sessionResult.id) return;

  // Task is still in a running status (agent exited without update_progress).
  // Parent vs leaf decision: fire both child counts in parallel — both are
  // independent SELECTs and at least one is needed on every running-status
  // path.
  const [childNotComplete, childTotal] = await Promise.all([
    deps.taskRepo.countChildrenNotComplete(taskId),
    deps.taskRepo.countChildren(taskId),
  ]);
  if (childNotComplete > 0) {
    // Parent waiting on non-terminal children. Their post-dispatch will
    // bubble through `checkAndCompleteParent` when the last one settles.
    return;
  }

  if (childTotal > 0) {
    // Parent task whose children have all settled (mixed outcomes possible).
    // M6: do not auto-retry parents — log + try the rollup. If all children
    // are 'done', this completes the parent; otherwise it stays in_progress
    // for operator review (issue #21 tracks full mixed-outcome rollup).
    console.warn(
      `[post-dispatch] parent ${taskId} has ${childTotal} all-terminal children; running rollup`,
    );
    await deps.taskService.checkAndCompleteParent(taskId);
    return;
  }

  // Leaf, agent forgot update_progress — retry once with a nudge prompt.
  const retryIntent =
    `<task id="${taskId}"/>\n` +
    `${NUDGE_COMPLETION_MARKER}Your previous session exited without ` +
    `setting a terminal task status. Please call update_progress with ` +
    `done/failed/blocked.</context>`;

  await deps.agentSession.run({
    agentId,
    taskId,
    type: "task",
    intent: retryIntent,
    priorSessionId: sessionResult.id,
    workspace,
    abortSignal: new AbortController().signal,
    skipOnComplete: true,
  });

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
 * Helper used by the bootstrap hook: given a terminal task session, look up
 * the agent + workspace + per-agent memory, build a retry-only AgentSession
 * (with NO `onSessionComplete` so the retry's terminal write can never
 * recurse back into this hook), and call `postDispatchCheck`.
 */
export interface BuildHookDeps {
  taskRepo: TaskRepository;
  taskService: TaskService;
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  runtimeRegistry: RuntimeRegistry;
  workspaceManager: WorkspaceManager;
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

export function buildPostDispatchHook(
  deps: BuildHookDeps,
): (session: Session) => Promise<void> {
  return async (session) => {
    // Mesh / chat sessions don't have `update_progress` semantics to chase.
    if (session.type !== "task" || !session.task_id) return;

    const agent: Agent | undefined = await deps.agentRepo.findById(
      session.agent_id,
    );
    if (!agent) return;
    const runtime = deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) return;
    const workspace = await deps.workspaceManager.ensureWorkspace({ agent });
    const memoryAgent = deps.makeMemoryAgent(agent.id);

    // Per-call AgentSession for the retry. `onSessionComplete` intentionally
    // omitted — the retry's terminal write must NOT recursively re-enter
    // this hook (would otherwise spawn retry-of-retry on every status-not-
    // set scenario).
    const retryAgentSession = new AgentSession({
      agentRepo: deps.agentRepo,
      sessionRepo: deps.sessionRepo,
      sessionEventRepo: deps.sessionEventRepo,
      runtime,
      memoryAgent,
    });

    await postDispatchCheck(
      {
        taskRepo: deps.taskRepo,
        taskService: deps.taskService,
        agentSession: retryAgentSession,
        sessionRepo: deps.sessionRepo,
      },
      session.task_id,
      session.agent_id,
      workspace,
      session,
    );
  };
}
