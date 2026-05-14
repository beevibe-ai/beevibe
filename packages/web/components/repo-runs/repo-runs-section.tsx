"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronRight,
  Terminal,
} from "lucide-react";
import type { ToolRun } from "@/lib/fixtures/repo-runs";
import {
  formatDiskMb,
  formatDurationMinutes,
  shortRepoLabel,
} from "@/lib/fixtures/repo-runs";
import { formatRelativeTime } from "@/lib/format";
import { ArtifactPreview } from "./artifact-preview";
import { RunStatusPill } from "./run-status-pill";

/**
 * "Recent work" — a list of sandboxed tool runs. Each row reads as a
 * sentence about what an agent did. Technical detail (commit, install
 * attempts, disk, network) lives behind a "Show details" disclosure so
 * the default view stays product-clean.
 */
export function RepoRunsSection({
  runs,
  taskId,
  heading = "Recent work",
  defaultOpenFirst = false,
}: {
  runs: ToolRun[];
  taskId: string;
  heading?: string;
  defaultOpenFirst?: boolean;
}) {
  if (runs.length === 0) return null;
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
        {heading}{" "}
        <span className="text-muted-foreground/70 tabular-nums">
          {runs.length}
        </span>
      </h2>
      <ul className="space-y-2">
        {runs.map((run, i) => (
          <ToolRunRow
            key={run.id}
            run={run}
            taskId={taskId}
            initiallyOpen={defaultOpenFirst && i === 0}
          />
        ))}
      </ul>
    </section>
  );
}

export function ToolRunRow({
  run,
  taskId,
  initiallyOpen = false,
}: {
  run: ToolRun;
  taskId: string;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [saved, setSaved] = useState(Boolean(run.saved));
  const ChevronIcon = open ? ChevronDown : ChevronRight;
  const canSave = run.has_draft_skill && run.status === "succeeded";

  return (
    <li className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-3 hover:bg-secondary/30 transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <div className="flex items-start gap-2.5">
          <ChevronIcon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground/90 leading-snug">
              <span className="text-muted-foreground">{run.agent_label}</span>{" "}
              {phrasing(run.status)}{" "}
              <span className="font-mono text-xs">{run.repo_short_name}</span>{" "}
              <span className="text-muted-foreground">to</span>{" "}
              {lowerFirst(run.goal)}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
              <span>
                {run.artifacts.length}{" "}
                {run.artifacts.length === 1 ? "artifact" : "artifacts"}
              </span>
              <span>·</span>
              <span>{formatDurationMinutes(run.details.elapsed_minutes)}</span>
              <span>·</span>
              <span>{formatRelativeTime(run.started_at)}</span>
              {saved ? (
                <span className="inline-flex items-center gap-1 text-status-done">
                  <BookmarkCheck className="h-3 w-3" />
                  saved
                </span>
              ) : null}
            </div>
          </div>
          <RunStatusPill status={run.status} className="shrink-0" />
        </div>

        {run.status === "blocked" && run.blocked_reason ? (
          <p className="ml-6 mt-2 rounded border border-status-blocked/30 bg-status-blocked/5 text-status-blocked text-[11px] px-2 py-1.5">
            {run.blocked_reason}
          </p>
        ) : null}
      </button>

      {open ? (
        <div className="border-t border-border/60 p-3 bg-background/40 space-y-3">
          <p className="text-xs text-foreground/85">{run.summary}</p>

          <ArtifactPreview artifacts={run.artifacts} />

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/40">
            <Link
              href={`/tasks/${taskId}/sessions/${run.session_short_id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Terminal className="h-3 w-3" />
              <span className="font-mono">{run.session_short_id}</span>
            </Link>
            {canSave ? (
              <SaveButton saved={saved} onToggle={() => setSaved((v) => !v)} />
            ) : null}
          </div>

          <Details run={run} />
        </div>
      ) : null}
    </li>
  );
}

function Details({ run }: { run: ToolRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer inline-flex items-center gap-1"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {open ? "Hide details" : "Show details"}
      </button>
      {open ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          <dt>Repo</dt>
          <dd className="font-mono">
            <a
              href={run.repo_url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground transition-colors"
            >
              {shortRepoLabel(run.repo_url)} @{" "}
              {run.details.pinned_commit.slice(0, 7)}
            </a>
          </dd>
          <dt>Install attempts</dt>
          <dd className="tabular-nums">{run.details.install_attempts}</dd>
          <dt>Disk used</dt>
          <dd className="tabular-nums">{formatDiskMb(run.details.disk_mb)}</dd>
          <dt>Network after clone</dt>
          <dd>{run.details.network_after_clone_used ? "yes" : "no"}</dd>
        </dl>
      ) : null}
    </div>
  );
}

function SaveButton({
  saved,
  onToggle,
}: {
  saved: boolean;
  onToggle: () => void;
}) {
  if (saved) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-[11px] text-status-done hover:opacity-80 transition-opacity cursor-pointer"
      >
        <BookmarkCheck className="h-3.5 w-3.5" />
        Saved as team tool
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="h-7 px-3 rounded text-[11px] font-medium border border-border bg-card hover:bg-secondary transition-colors cursor-pointer inline-flex items-center gap-1"
    >
      <Bookmark className="h-3 w-3" />
      Save as team tool
    </button>
  );
}

/** Turn the status into a sentence verb for the row's one-line summary. */
function phrasing(status: ToolRun["status"]): string {
  switch (status) {
    case "running":
      return "is using";
    case "succeeded":
      return "used";
    case "partial":
      return "partially used";
    case "blocked":
      return "tried to use";
    case "failed":
      return "couldn't use";
  }
}

function lowerFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
