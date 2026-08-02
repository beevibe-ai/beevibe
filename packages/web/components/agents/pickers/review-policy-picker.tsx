"use client";

import { api } from "@/lib/api/client";
import {
  ChipCaret,
  ChipMenuItem,
  ChipPopover,
} from "@/components/agents/pickers/chip-popover";
import {
  PICKER_SELECT_CLASS,
  PickerCard,
  PickerError,
  PickerHelp,
  useAgentSettingMutation,
} from "@/components/agents/pickers/picker-card";
import type { AgentDisplay } from "@/lib/api/types";
import type { ReviewPolicy } from "@beevibe/core";

function useReviewPolicyMutation(agentId: string) {
  return useAgentSettingMutation((policy: ReviewPolicy) =>
    api.agents.setReviewPolicy(agentId, policy),
  );
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
    <PickerCard title="Review policy">
      <select
        value={current}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value as ReviewPolicy)}
        className={PICKER_SELECT_CLASS}
      >
        <option value="auto_done">Auto-done (default)</option>
        <option value="require_human">Require human review</option>
      </select>
      {mutation.isError ? <PickerError>Couldn&apos;t update review policy.</PickerError> : null}
      <PickerHelp>
        When the agent declares a task <span className="font-mono">done</span>,
        auto-done closes it. Require-human routes it through{" "}
        <span className="font-mono">review</span> so you sign off first.
      </PickerHelp>
    </PickerCard>
  );
}
