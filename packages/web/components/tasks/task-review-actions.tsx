"use client";

import { useState } from "react";
import {
  useApproveTask,
  useRejectTask,
  useReviseTask,
} from "@/lib/hooks/use-task-mutations";
import { cn } from "@/lib/utils";

/**
 * Approve / reject / request-revision for a task in review.
 *
 * Both review surfaces — the full `/tasks/:id` page and the kanban peek
 * panel — had grown their own copy of this: the same three mutation
 * hooks, the same `anyPending` gate, the same `lastError` pick, the same
 * revise-drawer toggle, and the same "trim the feedback, bail if empty,
 * clear and close on success" submit. Only the scale and two labels
 * differed, so the behaviour was duplicated to keep the presentation
 * apart.
 *
 * The split here is behaviour vs. presentation: {@link useTaskReview}
 * owns the state and the mutations, {@link TaskReviewActions} renders
 * it at one of two scales. The page needs the hook separately anyway —
 * it feeds `anyPending` to `TaskLifecycleActions`' `extraDisabled` so
 * Cancel can't race an in-flight approve.
 *
 * `variant` names the surface rather than a size because the two
 * layouts differ by more than scale and both are deliberate: the page
 * right-aligns with Approve last (primary action at the end of the
 * row, with a labelled feedback field), while the 320px panel leads
 * with a full-width Approve and drops the label it has no room for.
 */

type ReviewMutation = "approve" | "reject" | "revise";

const ACTIONS: ReviewMutation[] = ["approve", "reject", "revise"];

export interface TaskReview {
  approve: ReturnType<typeof useApproveTask>;
  reject: ReturnType<typeof useRejectTask>;
  revise: ReturnType<typeof useReviseTask>;
  /** True while any of the three is in flight. Gates all three buttons. */
  anyPending: boolean;
  /** First error among the three, or null. */
  lastError: Error | null;
  /** Which action produced `lastError`, for the message. */
  lastErrorAction: ReviewMutation | null;
  reviseOpen: boolean;
  setReviseOpen: (next: boolean) => void;
  feedback: string;
  setFeedback: (next: string) => void;
  /** Trim, bail on empty, then clear + close the drawer on success. */
  submitRevise: () => void;
}

export function useTaskReview(taskId: string): TaskReview {
  const approve = useApproveTask(taskId);
  const reject = useRejectTask(taskId);
  const revise = useReviseTask(taskId);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const hooks = { approve, reject, revise };

  const submitRevise = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    revise.mutate(
      { feedback: trimmed },
      {
        onSuccess: () => {
          setFeedback("");
          setReviseOpen(false);
        },
      },
    );
  };

  return {
    approve,
    reject,
    revise,
    anyPending: ACTIONS.some((a) => hooks[a].isPending),
    lastError: ACTIONS.map((a) => hooks[a].error).find((e) => e) ?? null,
    lastErrorAction: ACTIONS.find((a) => hooks[a].isError) ?? null,
    reviseOpen,
    setReviseOpen,
    feedback,
    setFeedback,
    submitRevise,
  };
}

const BTN_BASE =
  "rounded font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY =
  "rounded font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_OUTLINE = `${BTN_BASE} border border-border hover:bg-secondary`;

interface Scale {
  /** The three main action buttons. */
  action: string;
  /** Cancel / submit inside the revise drawer. */
  drawer: string;
  textarea: string;
  error: string;
}

const SCALES: Record<"page" | "panel", Scale> = {
  page: {
    action: "h-9 px-3 text-sm",
    drawer: "h-8 px-3 text-xs",
    textarea: "px-2 py-1.5 text-sm",
    error: "text-xs text-right",
  },
  panel: {
    action: "h-8 px-3 text-xs",
    drawer: "h-7 px-2.5 text-[11px]",
    textarea: "px-2 py-1 text-xs",
    error: "text-[11px]",
  },
};

export function TaskReviewActions({
  review,
  variant,
}: {
  review: TaskReview;
  variant: "page" | "panel";
}) {
  const { approve, reject, revise, anyPending, lastError, lastErrorAction } = review;
  const s = SCALES[variant];
  const isPanel = variant === "panel";

  const approveBtn = (
    <button
      key="approve"
      type="button"
      disabled={anyPending}
      onClick={() => approve.mutate({})}
      className={cn(BTN_PRIMARY, s.action, isPanel && "flex-1")}
    >
      {approve.isPending ? "Approving…" : "Approve"}
    </button>
  );

  const reviseBtn = (
    <button
      key="revise"
      type="button"
      disabled={anyPending}
      onClick={() => review.setReviseOpen(!review.reviseOpen)}
      className={cn(BTN_OUTLINE, s.action)}
    >
      {isPanel ? "Revise" : "Request revision"}
    </button>
  );

  const rejectBtn = (
    <button
      key="reject"
      type="button"
      disabled={anyPending}
      onClick={() => reject.mutate({})}
      className={cn(BTN_OUTLINE, s.action)}
    >
      {reject.isPending ? "Rejecting…" : "Reject"}
    </button>
  );

  return (
    <div className={isPanel ? "mt-4 space-y-2" : undefined}>
      <div
        className={
          isPanel ? "flex items-center gap-2" : "flex justify-end gap-2 mb-2"
        }
      >
        {isPanel
          ? [approveBtn, reviseBtn, rejectBtn]
          : [rejectBtn, reviseBtn, approveBtn]}
      </div>

      {review.reviseOpen ? (
        <div
          className={
            isPanel
              ? "rounded-md border border-border bg-background/40 p-2.5 space-y-2"
              : "mb-2 rounded-lg border border-border bg-card p-3 space-y-2"
          }
        >
          {isPanel ? null : (
            <label className="block text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Revision feedback
            </label>
          )}
          <textarea
            value={review.feedback}
            onChange={(e) => review.setFeedback(e.target.value)}
            placeholder="What needs to change?"
            rows={3}
            className={cn(
              "w-full rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring",
              s.textarea,
            )}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                review.setReviseOpen(false);
                review.setFeedback("");
              }}
              className={cn(BTN_OUTLINE, s.drawer)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={anyPending || review.feedback.trim().length === 0}
              onClick={review.submitRevise}
              className={cn(BTN_PRIMARY, s.drawer)}
            >
              {revise.isPending ? "Submitting…" : isPanel ? "Submit" : "Submit revision"}
            </button>
          </div>
        </div>
      ) : null}

      {lastError ? (
        <div className={cn("text-status-failed", s.error)}>
          Couldn&apos;t {lastErrorAction ?? "submit"}: {lastError.message}
        </div>
      ) : null}
    </div>
  );
}
