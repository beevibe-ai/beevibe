"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * "Save as capability" — promote a finished repo run into a learned skill.
 *
 * Reachable from two places, which had each built the dialog from scratch:
 * the run detail page ("Save" step of the capability flow) and the work
 * product row on a task detail page. Both POSTed the same
 * `learnedSkills.create({name, goal_pattern, repo_run_id})`, both carried
 * the same `done` success block with its "View in Capabilities" link, both
 * had a name input with the same placeholder and the same
 * `pattern="[a-z0-9-]{2,64}"`, both had a goal textarea, the same error
 * line and the same Cancel/submit pair.
 *
 * They had also both hand-rolled the backdrop that `ModalOverlay` exists to
 * own, which is why the duplication was easy to miss: the two copies
 * matched each other (`bg-black/50` vs `bg-black/60`) but neither matched
 * the component, so they read as a pair of one-offs rather than as copies
 * three and four of the house modal.
 *
 * Copy and chrome are settled here rather than parameterized, since the
 * differences were drift: `green-600` vs `emerald-600` for the success
 * line, two different sets of input classes, "Save" vs "Save to library".
 * The one real difference survives as a prop — `altGoal`, the run page's
 * one-click "use the agent's summary instead" shortcut, which the task
 * page has no equivalent for.
 */

const FIELD_CLASS =
  "w-full rounded-md border border-border/40 bg-background/50 px-3 py-2 text-sm " +
  "focus:outline-none focus:border-border focus:bg-background focus:ring-1 " +
  "focus:ring-ring/30 transition-colors";

const LABEL_CLASS = "text-xs font-medium text-muted-foreground block mb-1";

const HELP_CLASS = "text-[11px] text-muted-foreground mt-1";

export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  altGoal,
  onClose,
}: {
  /** The `repo_run` row this capability is derived from. */
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /**
   * Optional alternative goal pattern the user can adopt in one click —
   * the run page offers the agent's own wrap-up summary here. The button
   * is hidden when absent, or when it already matches what's in the box.
   */
  altGoal?: { label: string; value: string };
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

  const showAlt = altGoal !== undefined && altGoal.value !== goal;

  return (
    <ModalOverlay onClose={onClose} className="p-6">
      <h2 className="text-base font-semibold mb-1">Save as capability</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Adds this run to your capability library. Agents pick it up via
        find_repo when a goal matches the pattern below.
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
            <label className={LABEL_CLASS} htmlFor="capability-name">
              Capability name
            </label>
            <input
              id="capability-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="extract-pdf-tables"
              pattern="[a-z0-9-]{2,64}"
              required
              className={FIELD_CLASS}
            />
            <p className={HELP_CLASS}>
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
                When should this trigger?
              </label>
              {showAlt ? (
                <button
                  type="button"
                  onClick={() => setGoal(altGoal.value)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {altGoal.label}
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
              className={`${FIELD_CLASS} resize-none`}
            />
            <p className={HELP_CLASS}>
              Describe the situation in plain language — find_repo
              full-text-matches future goals against this. Drop one-time
              context so the pattern stays reusable.
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
              {save.isPending ? "Saving…" : "Save to library"}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  );
}
