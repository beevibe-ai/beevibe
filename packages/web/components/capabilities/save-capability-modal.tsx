"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

/**
 * "Save as capability" dialog — turns a finished repo run into a
 * learned-skill registry entry.
 *
 * Two surfaces open this: the run-detail page under /capabilities/runs,
 * and the work-product row on a task detail page. Each had grown its own
 * ~135-line copy of the same dialog — same `learnedSkills.create`
 * mutation, same name + goal_pattern pair, same done/error/pending
 * states, same Cancel/Save footer — and they had already drifted: only
 * the run-detail copy offered the "use the agent's summary" shortcut, and
 * the two disagreed about the name field's guidance text.
 * `lib/capabilities.ts` says these surfaces are meant to share their
 * helpers; the dialog they both wrap belongs in the same place.
 *
 * The visual treatment is the run-detail one (themed borders and focus
 * rings, the richer field guidance) — the newer and more complete of the
 * two. Everything that genuinely differed in *meaning* rather than in
 * styling stays a prop: the blurb under the title, the goal field's label
 * and help text, and the submit button's wording all address different
 * audiences on the two pages.
 *
 * Deliberately NOT built on `components/modal-overlay.tsx`: that one
 * renders a blurred `bg-background/60` backdrop, where both copies of
 * this dialog use a plain `bg-black/60`. Harmonizing the two backdrop
 * treatments is a design call, not a refactor, so it is left alone.
 */
export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  summaryPattern,
  description,
  goalLabel = "Goal pattern",
  goalHelp,
  goalPlaceholder,
  submitLabel = "Save",
  onClose,
}: {
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /**
   * An alternative goal pattern derived from the agent's own wrap-up
   * message. When present and different from the current value, a
   * "Use agent's summary →" shortcut appears above the textarea.
   */
  summaryPattern?: string;
  /** Blurb under the title. */
  description: string;
  goalLabel?: string;
  /** Help text under the goal textarea. */
  goalHelp: string;
  goalPlaceholder?: string;
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card rounded-lg shadow-2xl ring-1 ring-border/40 w-full max-w-md p-6">
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
                className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Lowercase letters, numbers, hyphens — 2–64 chars. Becomes the
                slash command (e.g. /skill/<span className="font-mono">{name || "your-name"}</span>).
              </p>
            </div>
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {goalLabel}
                </label>
                {summaryPattern && summaryPattern !== goal ? (
                  <button
                    type="button"
                    onClick={() => setGoal(summaryPattern)}
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
                className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm resize-none focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
              />
              <p className="text-[11px] text-muted-foreground mt-1">{goalHelp}</p>
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
      </div>
    </div>
  );
}
