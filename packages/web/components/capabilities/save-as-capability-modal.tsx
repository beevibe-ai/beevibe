"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * "Save as capability": name a finished repo run and POST it to
 * /learned-skills, then flip to a confirmation linking at /capabilities
 * so the user sees the new entry in their "Your capabilities" tab.
 *
 * Both surfaces that offer this — the work-product card on a task
 * (/tasks/:id) and the outro on a capability run
 * (/capabilities/runs/:id) — had built the whole dialog by hand, same
 * two fields over the same mutation and the same done/not-done switch,
 * ~100 lines each. The copy differs on purpose (see the props below);
 * everything else had simply drifted:
 *
 *   - backdrop `bg-black/50` vs `bg-black/60 p-4`
 *   - card `border … shadow-xl mx-4` vs `ring-1 ring-border/40 shadow-2xl`
 *   - the success tick in `text-green-600` on one, `text-emerald-600`
 *     on the other
 *   - input focus ring `focus:ring-2 focus:ring-ring` vs
 *     `focus:ring-1 focus:ring-ring/30` plus a border/background shift
 *   - hint text at `text-xs` vs `text-[11px]`
 *   - the submit button reading "Save to library" vs "Save", and the
 *     confirmation's Close button missing `type="button"` on one
 *
 * Neither used `ModalOverlay`, which already existed for exactly this
 * backdrop-plus-card shape; this one does, so the save dialogs now
 * dismiss and stack like the two invite dialogs.
 */
export function SaveAsCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  blurb,
  goalLabel,
  goalHint,
  goalPlaceholder,
  nameHint,
  goalSuggestion,
  onClose,
}: {
  /** The succeeded run this capability is minted from. */
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /** One-line explanation under the title. Differs per surface — the
   *  task card speaks in terms of reuse, the run outro in terms of the
   *  learned-skill registry and find_repo. */
  blurb: ReactNode;
  /** Label over the goal field — "When should this trigger?" on the
   *  task card, "Goal pattern" on the run outro. */
  goalLabel: string;
  /** Help text under the goal field. */
  goalHint: ReactNode;
  goalPlaceholder?: string;
  /** Help text under the name field. */
  nameHint: ReactNode;
  /**
   * Optional one-click alternative for the goal field, offered beside
   * the label. The run outro uses it to drop in the pattern derived
   * from the agent's wrap-up summary; the task card has no second
   * candidate to offer.
   */
  goalSuggestion?: { label: string; value: string };
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [goal, setGoal] = useState(initialGoal);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.learnedSkills.create({ name, goal_pattern: goal, repo_run_id: repoRunId }),
    onSuccess: () => setDone(true),
  });

  const header = (
    <>
      <h2 className="text-base font-semibold mb-1">Save as capability</h2>
      <p className="text-xs text-muted-foreground mb-4">{blurb}</p>
    </>
  );

  if (done) {
    return (
      <ModalOverlay onClose={onClose} className="p-6">
        {header}
        <div className="space-y-3">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            ✓ Saved as <strong>{name}</strong>.
          </p>
          <Link
            href="/capabilities"
            className="block text-center w-full rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            View in Capabilities →
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay
      onClose={onClose}
      className="p-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {header}
      <div className="space-y-4">
        <div>
          <label
            className="text-xs font-medium text-muted-foreground block mb-1"
            htmlFor="capability-name"
          >
            Capability name
          </label>
          <input
            id="capability-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="extract-pdf-tables"
            // Mirrors the server-side check in POST /learned-skills.
            pattern="[a-z0-9-]{2,64}"
            required
            className={FIELD_CLASS}
          />
          <p className="text-xs text-muted-foreground mt-1">{nameHint}</p>
        </div>
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="capability-goal"
            >
              {goalLabel}
            </label>
            {goalSuggestion && goalSuggestion.value !== goal ? (
              <button
                type="button"
                onClick={() => setGoal(goalSuggestion.value)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                {goalSuggestion.label}
              </button>
            ) : null}
          </div>
          <textarea
            id="capability-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder={goalPlaceholder}
            required
            className={`${FIELD_CLASS} resize-none`}
          />
          <p className="text-xs text-muted-foreground mt-1">{goalHint}</p>
        </div>
        {save.error ? (
          <p className="text-xs text-red-500">
            {save.error instanceof Error ? save.error.message : "Save failed."}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending}
            className="flex-1 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {save.isPending ? "Saving…" : "Save to library"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

const FIELD_CLASS =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
