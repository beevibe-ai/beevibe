"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

/**
 * "Save as capability" dialog — the single implementation.
 *
 * Two surfaces offer this: the playground run outro
 * (`/capabilities/runs/[id]`) and a task's work-product row
 * (`/tasks/[id]`). Each had its own copy of this component, and they had
 * drifted — different help copy, different success color, different field
 * labels ("Goal pattern" vs "When should this trigger?"), different
 * backdrop opacity — while POSTing the identical
 * `{ name, goal_pattern, repo_run_id }` body to the same endpoint and
 * running the same form → confirmation state machine. A copy fix landed on
 * one surface and not the other, which is exactly the drift
 * `lib/capabilities.ts` was created to stop.
 *
 * The richer playground variant is kept as canonical, so the task surface
 * gains its fuller help text and the `summaryPattern` affordance.
 *
 * Deliberately NOT built on `components/modal-overlay.tsx`: that card has a
 * different backdrop (blurred, not black) and padding, so adopting it would
 * restyle both dialogs. Harmonizing the app's modal chrome is a visual call,
 * separate from collapsing these two copies into one.
 */
export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  summaryPattern,
  onClose,
}: {
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /**
   * An alternative goal pattern derived from the agent's own wrap-up, offered
   * as a one-click "Use agent's summary →". Omit to hide the affordance; it is
   * also hidden when it matches what's already in the field.
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card rounded-lg shadow-2xl ring-1 ring-border/40 w-full max-w-md p-6">
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
                className="flex-1 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
