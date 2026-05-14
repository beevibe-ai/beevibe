"use client";

import { useState } from "react";
import { ExternalLink, Loader2, PlayCircle, Sparkles } from "lucide-react";
import {
  FIXTURE_GOALS,
  fitLabel,
  getGoalBySlug,
  historyLine,
  nextLabel,
  type Candidate,
  type DiscoveryResult,
  type Fit,
} from "@/lib/fixtures/discovery";
import { shortRepoLabel } from "@/lib/fixtures/repo-runs";
import { cn } from "@/lib/utils";

/**
 * "What do you need done?" — the entry point. Real `Run this` on
 * candidates with `real_repo: true` (currently just pdfplumber); demo-
 * only on the others until they're wired to live repos.
 */
export function DiscoveryPanel({
  onLaunch,
}: {
  /** POSTs the run to the backend and returns the run_id. Parent surfaces it. */
  onLaunch: (input: {
    repo_url: string;
    goal: string;
    candidate: Candidate;
  }) => Promise<string | null>;
}) {
  const [slug, setSlug] = useState<string>(FIXTURE_GOALS[0]!.slug);
  const [launching, setLaunching] = useState<string | null>(null);
  const goal = getGoalBySlug(slug);

  const launch = async (cand: Candidate, goalText: string): Promise<void> => {
    if (!cand.real_repo) return;
    setLaunching(cand.id);
    try {
      await onLaunch({
        repo_url: cand.repo_url,
        goal: cand.goal_override ?? goalText,
        candidate: cand,
      });
    } finally {
      setLaunching(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="p-4 border-b border-border/60">
        <h2 className="text-sm font-medium leading-tight mb-1">
          What do you need done?
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Pick a starter or type a goal. We&apos;ll find a repo that can do
          it, try it safely, and bring back the result.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {FIXTURE_GOALS.map((g) => (
            <GoalChip
              key={g.slug}
              label={g.goal}
              active={g.slug === slug}
              onClick={() => setSlug(g.slug)}
            />
          ))}
        </div>
      </header>

      {goal ? (
        <CandidatesList
          goal={goal}
          launchingId={launching}
          onLaunch={(cand) => launch(cand, goal.goal)}
        />
      ) : null}
    </section>
  );
}

function GoalChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-[11px] transition-colors cursor-pointer",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60",
      )}
    >
      {label}
    </button>
  );
}

function CandidatesList({
  goal,
  launchingId,
  onLaunch,
}: {
  goal: DiscoveryResult;
  launchingId: string | null;
  onLaunch: (cand: Candidate) => void;
}) {
  return (
    <ul className="divide-y divide-border/60">
      {goal.candidates.map((c) => (
        <li key={c.id}>
          <CandidateRow
            candidate={c}
            launching={launchingId === c.id}
            onLaunch={() => onLaunch(c)}
          />
        </li>
      ))}
    </ul>
  );
}

const FIT_DOT: Record<Fit, string> = {
  high: "bg-status-done",
  medium: "bg-status-review",
  low: "bg-status-failed",
};

function CandidateRow({
  candidate: c,
  launching,
  onLaunch,
}: {
  candidate: Candidate;
  launching: boolean;
  onLaunch: () => void;
}) {
  return (
    <div className="p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <h3 className="text-sm font-medium">{c.display_name}</h3>
          <span className="font-mono text-[10px] text-muted-foreground truncate">
            {shortRepoLabel(c.repo_url)}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", FIT_DOT[c.fit])} aria-hidden />
            {fitLabel(c.fit)}
          </span>
        </div>
        <p className="text-xs text-foreground/85 mb-1">
          {c.short_description}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {c.prior_team_uses > 0 ? (
            <span className="inline-flex items-center gap-1 text-status-done">
              <Sparkles className="h-3 w-3" />
              {historyLine(c)}
            </span>
          ) : (
            <span>{historyLine(c)}</span>
          )}
          <span>·</span>
          <span>{c.license}</span>
          <a
            href={c.repo_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            view on GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
      <div className="shrink-0 pt-1">
        {!c.real_repo ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70"
            title="Wired up in a later PR — for the first POC only pdfplumber runs for real."
          >
            demo only
          </span>
        ) : launching ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-status-running">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Starting…
          </span>
        ) : (
          <button
            type="button"
            onClick={onLaunch}
            className={cn(
              "h-8 px-3 rounded text-xs font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5",
              c.next === "run"
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "border border-border bg-card hover:bg-secondary",
            )}
          >
            <PlayCircle className="h-3.5 w-3.5" />
            {nextLabel(c.next)}
          </button>
        )}
      </div>
    </div>
  );
}
