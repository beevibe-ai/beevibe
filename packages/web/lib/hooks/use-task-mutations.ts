import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ApproveTaskInput,
  type RejectTaskInput,
  type ReviseTaskInput,
  type CancelTaskInput,
} from "@/lib/api/client";
import { queryKeys } from "./keys";

function useTaskMutationInvalidations(taskId: string) {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    client.invalidateQueries({ queryKey: queryKeys.tasks.all });
    client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    // Approve/reject/revise transition tasks out of `review`/`blocked`,
    // which is the entire population of the inbox's task branches.
    // Without this, the row lingers in the sidebar until SSE delivers
    // `task.updated` (already wired, but unreliable behind buffering
    // proxies) or the user navigates and remounts.
    client.invalidateQueries({ queryKey: queryKeys.inbox.all });
  };
}

export function useApproveTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: ApproveTaskInput = {}) => api.tasks.approve(taskId, input),
    onSuccess,
  });
}

export function useRejectTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: RejectTaskInput = {}) => api.tasks.reject(taskId, input),
    onSuccess,
  });
}

export function useReviseTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: ReviseTaskInput) => api.tasks.revise(taskId, input),
    onSuccess,
  });
}

export function useCancelTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: CancelTaskInput = {}) => api.tasks.cancel(taskId, input),
    onSuccess,
  });
}

export function useRetryTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: () => api.tasks.retry(taskId),
    onSuccess,
  });
}

// ── Review actions (approve / reject / request-revision) ────────────────

type ReviewMutation = "approve" | "reject" | "revise";

const REVIEW_ACTIONS: ReviewMutation[] = ["approve", "reject", "revise"];

/**
 * The approve / reject / request-revision triad, as one hook.
 *
 * A task in `review` is actionable from two places — the full-page
 * `/tasks/[id]` client and the side `TaskDetailPanel` — and both had
 * grown their own copy of the same five pieces: the three mutation
 * hooks, the `reviseOpen` + feedback pair, the "is anything in flight"
 * roll-up, the trim-and-submit handler that clears the box and closes
 * the drawer on success, and the which-one-failed error roll-up. The
 * page client had already factored the roll-up out into a local
 * `reviewStatus()`; the panel recomputed it inline. The two word the
 * resulting message differently, and that wording stays at the call site.
 *
 * The *layout* differences between the two are deliberate and stay at
 * the call sites: the panel is compact (`h-8`, `text-xs`, "Revise") where
 * the page is roomy (`h-9`, `text-sm`, "Request revision"), and the two
 * order their buttons differently. So this unifies the behaviour and
 * leaves the markup alone — the thing a reader cannot verify by eye is
 * now in one place, and the thing they can is still local.
 *
 * `submitRevise` is a no-op on whitespace-only feedback rather than an
 * error, matching what both copies did: the Submit button is disabled in
 * that state (`canSubmitRevise`), so reaching it means the keyboard beat
 * the re-render.
 */
export function useTaskReview(taskId: string) {
  const approve = useApproveTask(taskId);
  const reject = useRejectTask(taskId);
  const revise = useReviseTask(taskId);

  const [reviseOpen, setReviseOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const hooks = { approve, reject, revise };
  const anyPending = REVIEW_ACTIONS.some((a) => hooks[a].isPending);
  const lastError = REVIEW_ACTIONS.map((a) => hooks[a].error).find((e) => e) ?? null;
  const lastErrorAction = REVIEW_ACTIONS.find((a) => hooks[a].isError) ?? null;

  const closeRevise = useCallback(() => {
    setReviseOpen(false);
    setFeedback("");
  }, []);

  const toggleRevise = useCallback(() => {
    setReviseOpen((v) => !v);
  }, []);

  const canSubmitRevise = !anyPending && feedback.trim().length > 0;

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
    anyPending,
    lastError,
    lastErrorAction,
    reviseOpen,
    toggleRevise,
    closeRevise,
    feedback,
    setFeedback,
    canSubmitRevise,
    submitRevise,
  };
}
