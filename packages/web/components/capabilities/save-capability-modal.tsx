"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ModalOverlay } from "@/components/modal-overlay";

/**
 * The "save this repo run as a reusable capability" dialog.
 *
 * Two surfaces open it — the run playground
 * (`/capabilities/runs/:id`) after a run settles, and a work-product row
 * on `/tasks/:id` whose product came from a repo run. Both had their own
 * copy of this component: same `api.learnedSkills.create` call, same
 * name + goal_pattern form, same flip-to-confirmation on success, same
 * link back to /capabilities. They had already drifted — different
 * backdrops, `emerald` vs `green` for the success line, and two
 * different accounts of the name field's constraints (the run page spelled
 * out "lowercase letters, numbers, hyphens — 2–64 chars" and explained the
 * resulting slash command; the tasks page said only "a short slug"),
 * even though one `pattern="[a-z0-9-]{2,64}"` governs both.
 *
 * Only the two bits of prose that are genuinely per-surface stay props:
 * `subtitle` (why you'd save from *here*) and `submitLabel`. Everything
 * structural is fixed here so the next field added to
 * `learnedSkills.create` lands in one form, not two.
 */
export function SaveCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  summaryPattern,
  subtitle,
  submitLabel = "Save",
  onClose,
}: {
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  /**
   * Alternative goal_pattern derived from the agent's own wrap-up
   * message, offered as a one-click swap. The run playground can
   * compute one from the transcript; the tasks page has no transcript
   * in hand, so it omits this and the affordance stays hidden.
   */
  summaryPattern?: string | undefined;
  subtitle: string;
  submitLabel?: string;
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
      <p className="text-xs text-muted-foreground mb-4">{subtitle}</p>
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
              Lowercase letters, numbers, hyphens — 2–64 chars. Becomes the slash
              command (e.g. /skill/
              <span className="font-mono">{name || "your-name"}</span>).
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
              full-text-matches future goals against this. Trim it down to the
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
              {save.isPending ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  );
}
