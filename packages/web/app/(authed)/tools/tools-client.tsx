"use client";

import { Box } from "lucide-react";
import { DetailShell } from "@/components/detail/detail-shell";
import { DiscoveryPanel } from "@/components/repo-runs/discovery-panel";
import { ToolRunRow } from "@/components/repo-runs/repo-runs-section";
import { SavedToolCard } from "@/components/repo-runs/saved-skills";
import {
  FIXTURE_RUNS,
  FIXTURE_SAVED_TOOLS,
} from "@/lib/fixtures/repo-runs";

/**
 * Tools — the product moment for "let agents borrow open-source repos
 * to do real work." One panel to start something, one list of what's
 * been done, and the saved ones the team kept around for next time.
 */
export function ToolsClient() {
  return (
    <DetailShell>
      <header className="mb-6">
        <div className="flex items-center gap-2 mb-1.5">
          <Box className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold leading-tight">Tools</h1>
          <span className="ml-2 inline-flex items-center rounded border border-border/60 bg-secondary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            POC
          </span>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Tell us what you want done. We&apos;ll find a repo that can do it,
          try it safely in a sandbox, and bring back the result. Save the ones
          worth keeping for next time.
        </p>
      </header>

      <div className="space-y-8">
        <DiscoveryPanel />

        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Recent work{" "}
            <span className="text-muted-foreground/70 tabular-nums">
              {FIXTURE_RUNS.length}
            </span>
          </h2>
          <ul className="space-y-2">
            {FIXTURE_RUNS.map((r, i) => (
              <ToolRunRow
                key={r.id}
                run={r}
                taskId={r.task_id}
                initiallyOpen={i === 0}
              />
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Saved for next time{" "}
            <span className="text-muted-foreground/70 tabular-nums">
              {FIXTURE_SAVED_TOOLS.length}
            </span>
          </h2>
          {FIXTURE_SAVED_TOOLS.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Nothing saved yet. Successful runs can be saved as team tools
              from the row above.
            </p>
          ) : (
            <div className="space-y-2">
              {FIXTURE_SAVED_TOOLS.map((t) => (
                <SavedToolCard key={t.name} tool={t} />
              ))}
            </div>
          )}
        </section>
      </div>
    </DetailShell>
  );
}
