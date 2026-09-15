"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * "Save as capability" — name a succeeded repo run and POST it to
 * `/learned-skills` so `find_repo` can offer it back on matching goals.
 *
 * Two pages open this, and each had built the whole dialog itself: the
 * run detail page at the end of the capability flow, and the task detail
 * page from the work product the run produced. Same mutation, same two
 * fields, same done-state-with-a-link-to-/capabilities — and, inevitably,
 * drift: `bg-black/50` against `bg-black/60`, `text-green-600` against
 * `text-emerald-600`, `border` against `ring-1 ring-border/40`,
 * `"Save failed"` against `"Save failed."`. One dialog for one action now.
 *
 * What genuinely differs between the callers is only where the defaults
 * come from — a work product's title and summary, or a run's repo URL and
 * goal — so that stays in the props. `suggestedGoal` is the run page's
 * "use the agent's summary instead" shortcut, offered only when it has
 * one and it isn't what's already in the box.
 */
export function SaveCapabilityDialog({
  repoRunId,
  initialName,
  initialGoal,
  suggestedGoal,
  goalHint,
  onClose,
}: {
  repoRunId: string;
  /** Pre-filled slug. Must satisfy `[a-z0-9-]{2,64}` to submit. */
  initialName: string;
  initialGoal: string;
  /** Offered as a one-click alternative goal pattern when it differs. */
  suggestedGoal?: string;
  /** Extra guidance under the goal field, about where its default came from. */
  goalHint?: ReactNode;
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

  return (
    <ModalOverlay onClose={onClose} className="p-6">
      <h2 className="text-base font-semibold mb-1">Save as capability</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Adds this run to your team&apos;s learned-skill registry. Specialist agents will
        pick it up via find_repo on matching goals.
      </p>
      {done ? (
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
            <label
              htmlFor="capability-name"
              className="text-xs font-medium text-muted-foreground block mb-1"
            >
              Capability name
            </label>
            <input
              id="capability-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="extract-pdf-tables"
              pattern="[a-z0-9-]{2,64}"
              required
              className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Lowercase letters, numbers, hyphens — 2–64 chars. Becomes the slash command
              (e.g. /skill/<span className="font-mono">{name || "your-name"}</span>).
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label
                htmlFor="capability-goal"
                className="text-xs font-medium text-muted-foreground"
              >
                Goal pattern
              </label>
              {suggestedGoal && suggestedGoal !== goal ? (
                <button
                  type="button"
                  onClick={() => setGoal(suggestedGoal)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Use agent&apos;s summary →
                </button>
              ) : null}
            </div>
            <textarea
              id="capability-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="e.g. when the user wants to extract tables from a PDF"
              required
              className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm resize-none focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              What kind of goals should reuse this recipe? find_repo full-text-matches
              future goals against this.{goalHint ? <> {goalHint}</> : null}
            </p>
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
              {save.isPending ? "Saving…" : "Save to library"}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  );
}
