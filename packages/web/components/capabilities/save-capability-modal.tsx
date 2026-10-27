"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * "Save as capability" — the one dialog that POSTs a succeeded repo run
 * to `/learned-skills`.
 *
 * Two surfaces open it: the work-product row on a task detail page and
 * the outro on `/capabilities/runs/[id]`. Each had its own copy — same
 * two fields, same mutation, same flip-to-confirmation on success — and
 * the copies had drifted into two different dialogs for one action:
 * different backdrops, input treatments, success colors and button
 * labels, so the same operation looked like two features.
 *
 * What legitimately differs is *copy* (the run page explains find_repo;
 * the task page talks about rerunning a recipe) and the run page's
 * "use agent's summary" shortcut. Those are props. The chrome is not:
 * it comes from `ModalOverlay`, which both call sites were bypassing
 * with a hand-rolled backdrop, and the field styling follows the
 * `border-border/40 bg-background/50` treatment used by the rest of the
 * app's inputs.
 */

/**
 * Field treatment shared by the two inputs. #465 is introducing a
 * `TEXT_INPUT_CLASS` in `components/text-input.tsx` for exactly this
 * string — fold this constant into it once that lands.
 */
const FIELD_CLASS =
  "w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm " +
  "focus:outline-none focus:border-border focus:bg-background focus:ring-1 " +
  "focus:ring-ring/30 transition-colors";

export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  description,
  nameHelp,
  goalLabel,
  goalHelp,
  goalPlaceholder,
  goalSuggestion,
  submitLabel = "Save",
  onClose,
}: {
  /** The succeeded run whose recipe is being saved. */
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /** Sub-head explaining what saving does on this surface. */
  description: ReactNode;
  /**
   * Hint under the name field. Takes the live field value so a caller
   * can preview the resulting slug as the user types.
   */
  nameHelp?: (name: string) => ReactNode;
  goalLabel: string;
  goalHelp?: ReactNode;
  goalPlaceholder?: string;
  /**
   * Optional one-click alternative for the goal field — the run page
   * offers the agent's own wrap-up summary. The button only shows when
   * the suggestion differs from what's in the field.
   */
  goalSuggestion?: string;
  submitLabel?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [goal, setGoal] = useState(initialGoal);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.learnedSkills.create({
        name,
        goal_pattern: goal,
        repo_run_id: repoRunId,
      }),
    onSuccess: () => setDone(true),
  });

  return (
    // `mx-4` keeps the gutter both originals had on a narrow screen — the
    // task copy via the card's own margin, the run copy via padding on its
    // backdrop. `ModalOverlay` supplies neither.
    <ModalOverlay onClose={onClose} className="p-6 mx-4">
      <h2 className="text-base font-semibold mb-1">Save as capability</h2>
      <p className="text-xs text-muted-foreground mb-4">{description}</p>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            ✓ Saved as <strong>{name}</strong>.
          </p>
          <Link
            href="/capabilities"
            className="block text-center w-full rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            View in Capabilities →
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md border border-border/40 px-4 py-2 text-sm hover:bg-secondary/50 transition-colors"
          >
            Close
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Capability name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="extract-pdf-tables"
              pattern="[a-z0-9-]{2,64}"
              required
              className={FIELD_CLASS}
            />
            {nameHelp ? (
              <p className="text-[11px] text-muted-foreground mt-1">{nameHelp(name)}</p>
            ) : null}
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">
                {goalLabel}
              </label>
              {goalSuggestion && goalSuggestion !== goal ? (
                <button
                  type="button"
                  onClick={() => setGoal(goalSuggestion)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Use agent&apos;s summary →
                </button>
              ) : null}
            </div>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder={goalPlaceholder}
              required
              className={`${FIELD_CLASS} resize-none`}
            />
            {goalHelp ? (
              <p className="text-[11px] text-muted-foreground mt-1">{goalHelp}</p>
            ) : null}
          </div>
          {save.error ? (
            <p className="text-xs text-red-500">
              {save.error instanceof Error ? save.error.message : "Save failed."}
            </p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border/40 px-4 py-2 text-sm hover:bg-secondary/50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className="flex-1 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  );
}
