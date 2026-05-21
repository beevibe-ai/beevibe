import { useCancelTask, useRetryTask } from "@/lib/hooks/use-task-mutations";
import {
  isRetryableTaskStatus,
  isTerminalTaskStatus,
} from "@/lib/task-status";
import { MutationError } from "@/components/mutation-error";
import type { TaskStatus } from "@beevibe/core";

/**
 * Self-contained Cancel + Retry block. Shared between the detail page
 * (`/tasks/[id]`) and the side peek panel (`/tasks?p=<id>`) so both
 * surfaces stay in sync on which statuses show which buttons.
 *
 * - Cancel renders when the task isn't terminal.
 * - Retry renders when the task is `failed` or `cancelled`.
 * - When neither applies (status is `done`), the component returns
 *   null and contributes nothing to layout.
 *
 * Renders a wrapper div so callers drop it as a sibling block — not
 * inside another flex row. The buttons are right-aligned to mirror
 * the previous detail-page placement (next to the status pill).
 *
 * `extraDisabled` lets the detail page also gate buttons during in-flight
 * review actions (approve/reject/revise) — without it, clicking Cancel
 * mid-approval would race. Defaults to false for callers (like the
 * panel) that have no concurrent review actions at the same scope.
 */
export function TaskLifecycleActions({
  task,
  extraDisabled = false,
}: {
  task: { id: string; status: TaskStatus };
  extraDisabled?: boolean;
}) {
  const cancel = useCancelTask(task.id);
  const retry = useRetryTask(task.id);
  const showCancel = !isTerminalTaskStatus(task.status);
  const showRetry = isRetryableTaskStatus(task.status);
  if (!showCancel && !showRetry) return null;
  return (
    <div className="mb-2">
      <div className="flex items-center justify-end gap-1.5">
        {showCancel ? (
          <button
            type="button"
            disabled={extraDisabled || cancel.isPending}
            onClick={() => cancel.mutate({})}
            className="h-7 px-2.5 rounded text-xs font-medium border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title="Cancel this task — stops any running session"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
        {showRetry ? (
          <button
            type="button"
            disabled={extraDisabled || retry.isPending}
            onClick={() => retry.mutate()}
            className="h-7 px-2.5 rounded text-xs font-medium border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title="Retry — re-dispatches the task; the agent resumes the prior CLI conversation"
          >
            {retry.isPending ? "Retrying…" : "Retry"}
          </button>
        ) : null}
      </div>
      <MutationError mutation={cancel} verb="cancel" />
      <MutationError mutation={retry} verb="retry" />
    </div>
  );
}
