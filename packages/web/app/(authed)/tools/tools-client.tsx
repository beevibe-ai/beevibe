"use client";

import { useState } from "react";
import { Box } from "lucide-react";
import { DetailShell } from "@/components/detail/detail-shell";
import { DiscoveryPanel } from "@/components/repo-runs/discovery-panel";
import { LiveRunCard } from "@/components/repo-runs/live-run";
import { ToolRunRow } from "@/components/repo-runs/repo-runs-section";
import { RunFromPromptForm } from "@/components/repo-runs/run-from-prompt";
import { SavedToolCard } from "@/components/repo-runs/saved-skills";
import {
  FIXTURE_RUNS,
  FIXTURE_SAVED_TOOLS,
} from "@/lib/fixtures/repo-runs";

/**
 * Tools — point at a repo, the agent uses it inside a sandbox, the
 * artifact appears here. Primary path is the "Run a repo" form; the
 * discovery panel below it stays as a quick-start affordance. Fixture
 * sections at the bottom serve as design reference until enough live
 * runs accumulate.
 */
export function ToolsClient() {
  const [liveRunIds, setLiveRunIds] = useState<string[]>([]);

  const launch = async (input: {
    repo_url: string;
    goal: string;
    input_url?: string;
    input_filename?: string;
  }): Promise<string | null> => {
    const r = await fetch("/api/tools/use-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error("use-repo failed", r.status, await r.text());
      return null;
    }
    const { run_id } = (await r.json()) as { run_id: string };
    setLiveRunIds((prev) => [run_id, ...prev]);
    return run_id;
  };

  const dismiss = (run_id: string): void => {
    setLiveRunIds((prev) => prev.filter((id) => id !== run_id));
  };

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
          Point at a GitHub repo and tell the agent what you want done.
          We clone, install, and run it inside a sandbox; the result
          comes back here. Your machine stays clean.
        </p>
      </header>

      <div className="space-y-8">
        <RunFromPromptForm onLaunch={launch} />

        {liveRunIds.length > 0 ? (
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Live runs{" "}
              <span className="text-muted-foreground/70 tabular-nums">
                {liveRunIds.length}
              </span>
            </h2>
            <ul className="space-y-2">
              {liveRunIds.map((id) => (
                <li key={id}>
                  <LiveRunCard runId={id} onDismiss={() => dismiss(id)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Or try a starter
          </h2>
          <DiscoveryPanel onLaunch={launch} />
        </section>

        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Example runs{" "}
            <span className="text-muted-foreground/70 tabular-nums">
              {FIXTURE_RUNS.length}
            </span>
            <span className="ml-2 text-[10px] text-muted-foreground/70 italic font-normal">
              fixture — design reference
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
