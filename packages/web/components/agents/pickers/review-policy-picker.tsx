"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import {
  ChipCaret,
  ChipMenuItem,
  ChipPopover,
} from "@/components/agents/pickers/chip-popover";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/api/types";
import type { ReviewPolicy } from "@beevibe/core";

function useReviewPolicyMutation(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: ReviewPolicy) =>
      api.agents.setReviewPolicy(agentId, policy),
    onSuccess: () => {
      // List rows source from useAgentNetwork() — different cache
      // slot from the per-agent detail. Both need to be bumped or
      // the view that wasn't invalidated stays stale.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentNetwork.all });
    },
  });
}

/** Eye icon used on the "Require human" chip. Tracks the chip's text color. */
function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * Chip-style review-policy picker. Shape-encoded state so you can read
 * the value at a glance even before the text registers:
 *   - Auto-done renders as a filled teal chip
 *   - Require-human renders as a ringed amber chip with an eye icon
 *
 * Legacy agents (provisioned before this column had a default) carry
 * review_policy=null; behaviorally that's identical to 'auto_done' in
 * TaskService, so render it that way too.
 */
export function ReviewPolicyChip({ agent }: { agent: AgentDisplay }) {
  const mutation = useReviewPolicyMutation(agent.id);
  const current: ReviewPolicy =
    agent.review_policy === "require_human" ? "require_human" : "auto_done";

  const isHuman = current === "require_human";
  const chipClass = isHuman
    ? "border border-amber-500/45 bg-transparent text-amber-300 hover:bg-amber-500/10"
    : "border border-emerald-500/35 bg-emerald-500/12 text-emerald-300 hover:bg-emerald-500/18";

  return (
    <ChipPopover
      ariaLabel={`Review policy: ${isHuman ? "Require human" : "Auto-done"}. Click to change.`}
      chipClassName={chipClass}
      disabled={mutation.isPending}
      chip={
        <>
          {isHuman ? <EyeIcon className="h-3 w-3" /> : null}
          <span>{isHuman ? "Require human" : "Auto-done"}</span>
          <ChipCaret />
        </>
      }
    >
      {(close) => (
        <>
          <ChipMenuItem
            selected={current === "auto_done"}
            label={<span className="text-[13px]">Auto-done</span>}
            sublabel="closes on done"
            onClick={() => {
              mutation.mutate("auto_done");
              close();
            }}
          />
          <ChipMenuItem
            selected={current === "require_human"}
            leading={<EyeIcon className="h-3 w-3 text-amber-400" />}
            label={<span className="text-[13px]">Require human</span>}
            sublabel="you sign off"
            onClick={() => {
              mutation.mutate("require_human");
              close();
            }}
          />
        </>
      )}
    </ChipPopover>
  );
}

/**
 * Card-wrapped review-policy picker for the agent detail aside. Same
 * native-select chrome the original card shipped with; the chip
 * variant above is the one the list view uses.
 */
export function ReviewPolicyPicker({ agent }: { agent: AgentDisplay }) {
  const mutation = useReviewPolicyMutation(agent.id);
  const current: ReviewPolicy =
    agent.review_policy === "require_human" ? "require_human" : "auto_done";

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
        Review policy
      </h3>
      <select
        value={current}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as ReviewPolicy)}
        className={cn(
          "w-full text-sm rounded border border-border bg-background px-2 py-1.5",
          "cursor-pointer disabled:opacity-50",
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
      <p className="text-[11px] text-muted-foreground mt-2 leading-snug">
        When the agent declares a task <span className="font-mono">done</span>,
        auto-done closes it. Require-human routes it through{" "}
        <span className="font-mono">review</span> so you sign off first.
      </p>
    </section>
  );
}
