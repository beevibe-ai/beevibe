"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * The "Save as capability" dialog, in one place.
 *
 * Two byte-for-byte-shaped copies of this existed — `SaveCapabilityModal`
 * in the repo-run playground (`/capabilities/runs/[id]`) and
 * `SaveAsCapabilityModal` on the task detail page (`/tasks/[id]`). Both
 * ran the same `api.learnedSkills.create({ name, goal_pattern,
 * repo_run_id })` mutation, both flipped to the same "✓ Saved as … /
 * View in Capabilities →" success state, and both rendered the same
 * name-input + goal-textarea + Cancel/Save footer. Only the copy and a
 * handful of Tailwind classes had drifted apart, which is the failure
 * mode this consolidation removes: the two dialogs were visibly
 * different takes on one flow.
 *
 * Divergences resolved in favour of the richer playground variant (it
 * explains how `find_repo` actually consumes the goal pattern), with
 * the backdrop + card chrome taken from the shared {@link ModalOverlay}
 * rather than a third hand-rolled `fixed inset-0` copy.
 */
export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  summaryPattern,
  onClose,
}: {
  /** The `repo_run` this recipe is distilled from. */
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /**
   * An alternative goal pattern derived from the agent's own summary.
   * When present and different from the current draft, the goal field
   * offers a one-click swap to it. The task page has no summary to
   * derive one from, so it omits this and the affordance stays hidden.
   */
  summaryPattern?: string;
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
    <ModalOverlay onClose={onClose} className="p-6">
      <h2 className="text-base font-semibold mb-1">Save as capability</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Adds this run to your team&apos;s learned-skill registry. Specialist
        agents will pick it up via find_repo on matching goals.
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
              pattern="[a-z0-9-]{2,64}"
              required
              className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Lowercase letters, numbers, hyphens — 2–64 chars. Becomes the
              slash command (e.g. /skill/
              <span className="font-mono">{name || "your-name"}</span>).
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="capability-goal"
              >
                Goal pattern
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
              id="capability-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              required
              className="w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm resize-none focus:outline-none focus:border-border focus:bg-background focus:ring-1 focus:ring-ring/30 transition-colors"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              What kind of goals should reuse this recipe? find_repo
              full-text-matches future goals against this. Default uses the
              first sentence of this run&apos;s goal; edit it down to the
              reusable bit (drop Context / one-time phrases).
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
              className="flex-1 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  );
}
