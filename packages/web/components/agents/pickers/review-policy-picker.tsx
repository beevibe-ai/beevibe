"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/api/types";
import type { ReviewPolicy } from "@beevibe/core";

/**
 * Bare review-policy `<select>`. Legacy agents (provisioned before this
 * column had a default) carry `review_policy=null`; behaviorally that's
 * identical to `auto_done` in TaskService, so render it that way too.
 */
export function ReviewPolicySelect({
  agent,
  className,
}: {
  agent: AgentDisplay;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const current: ReviewPolicy =
    agent.review_policy === "require_human" ? "require_human" : "auto_done";
  const mutation = useMutation({
    mutationFn: (policy: ReviewPolicy) =>
      api.agents.setReviewPolicy(agent.id, policy),
    onSuccess: () => {
      // Invalidate all agent queries: list rows + peek panel + detail
      // all carry review_policy.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });

  return (
    <>
      <select
        value={current}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as ReviewPolicy)}
        className={cn(
          "w-full text-sm rounded border border-border bg-background px-2 py-1.5 cursor-pointer disabled:opacity-50",
          className,
        )}
      >
        <option value="auto_done">Auto-done (default)</option>
        <option value="require_human">Require human review</option>
      </select>
      {mutation.isError ? (
        <p className="text-xs text-destructive mt-1.5">
          Couldn&apos;t update review policy.
        </p>
      ) : null}
    </>
  );
}

/**
 * Card-wrapped review-policy picker for the agent detail aside.
 */
export function ReviewPolicyPicker({ agent }: { agent: AgentDisplay }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Review policy
      </h3>
      <ReviewPolicySelect agent={agent} />
      <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
        When the agent declares a task <span className="font-mono">done</span>,
        auto-done closes it. Require-human routes it through{" "}
        <span className="font-mono">review</span> so you sign off first.
      </p>
    </section>
  );
}
