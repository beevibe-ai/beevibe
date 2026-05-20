"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Clock,
  ExternalLink,
  Loader2,
  RotateCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { api, type RepoRun } from "@/lib/api/client";
import { DetailShell } from "@/components/detail/detail-shell";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { cn } from "@/lib/utils";

const CapabilitiesBackLink = () => (
  <Link
    href="/capabilities"
    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
  >
    <ArrowLeft className="h-3 w-3" />
    Capabilities
  </Link>
);

/**
 * Playground for a repo_run. Two roles in one page:
 *   1. Watch the live transcript of a use_repo sandbox run.
 *   2. After it settles, let the user iterate — a textarea + button that
 *      starts a NEW use_repo on the same repo with a different goal.
 *
 * The chat-side "Try" button on a <repo_card> deep-links here. Users
 * never have to remember sandbox URLs or repo metadata — the page owns
 * both the watch and the iterate loop.
 */
export function RunDetailClient({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["repo-run", id],
    queryFn: () => api.repoRuns.get(id),
    refetchInterval: (d) => {
      const status = d.state.data?.run?.status;
      return status === "pending" || status === "running" ? 1500 : false;
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.repoRuns.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repo-run", id] }),
  });

  const run = data?.run;
  const isSettled =
    run &&
    (run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "blocked");

  if (isLoading) {
    return (
      <DetailShell nav={<CapabilitiesBackLink />}>
        <Skeleton className="h-7 w-1/3 mb-2" />
        <Skeleton className="h-4 w-1/4 mb-6" />
        <Skeleton className="h-20 w-full rounded-lg mb-4" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </DetailShell>
    );
  }

  if (!run) {
    return (
      <DetailShell nav={<CapabilitiesBackLink />}>
        <EmptyState
          icon={Sparkles}
          title="Run not found"
          description={`Run ${id} couldn't be loaded. Check the daemon logs.`}
        />
      </DetailShell>
    );
  }

  return (
    <DetailShell nav={<CapabilitiesBackLink />}>
      <header className="mb-6">
        <div className="flex items-center gap-2 flex-wrap mb-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Playground</span>
          <StatusPill status={run.status} />
          {(run.status === "pending" || run.status === "running") && (
            <button
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="ml-auto text-xs text-muted-foreground hover:text-red-500 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
        <RepoHero run={run} />
      </header>
      <div className="space-y-4">
        <GoalBlock run={run} />
        <TranscriptBlock run={run} />
        {isSettled ? <IterateBlock run={run} /> : null}
      </div>
    </DetailShell>
  );
}

function RepoHero({ run }: { run: RepoRun }) {
  const slug = run.repo_url.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <h1 className="text-base font-semibold tracking-tight leading-tight">
        {slug}
      </h1>
      <a
        href={run.repo_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        github
        <ExternalLink className="h-3 w-3" />
      </a>
      {run.repo_ref ? (
        <span className="text-[11px] font-mono text-muted-foreground/80">
          @ {run.repo_ref.slice(0, 12)}
        </span>
      ) : null}
      {run.task_id ? (
        <Link
          href={`/tasks?p=${run.task_id}`}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View artifacts
          <ArrowRight className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

function GoalBlock({ run }: { run: RepoRun }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
        Goal
      </p>
      <p className="text-sm text-foreground whitespace-pre-wrap">{run.goal}</p>
      {run.error ? (
        <p className="mt-2 text-xs text-red-500 whitespace-pre-wrap">{run.error}</p>
      ) : null}
    </div>
  );
}

function TranscriptBlock({ run }: { run: RepoRun }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const transcriptLen = run.transcript.length;

  // "Stick to bottom" UX: auto-scroll on new events, but only if the
  // user is already at (or near) the bottom. If they scrolled up to
  // read an earlier line, leave them where they are.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcriptLen]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    // 24px of slack — counts hovering near the bottom as "stuck".
    stickToBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Live transcript
        </p>
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {transcriptLen}
        </span>
        {(run.status === "pending" || run.status === "running") && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[480px] overflow-y-auto"
      >
        <div className="p-4">
          {transcriptLen === 0 ? (
            <p className="text-xs text-muted-foreground">
              {run.status === "pending" ? "Waiting for daemon…" : "No transcript."}
            </p>
          ) : (
            <div className="space-y-1.5 text-xs">
              {run.transcript.map((ev, i) => (
                <TranscriptLine key={i} ev={ev} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Iterate panel — visible after the run settles. Lets the user fire
 * another use_repo against the same repo without going back to chat
 * to type "find me … again, then click Try." The new run gets its
 * own /capabilities/runs/<id> page; we router.push there so the URL
 * tracks the playground state.
 */
function IterateBlock({ run }: { run: RepoRun }) {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const start = useMutation({
    mutationFn: () =>
      api.capabilities.use({
        repo_url: run.repo_url,
        goal: goal.trim(),
      }),
    onSuccess: (res) => {
      router.push(res.watch_url);
    },
  });

  const placeholder = examplePlaceholder(run);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
        <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Try another goal
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!goal.trim() || start.isPending) return;
          start.mutate();
        }}
        className="p-4 space-y-3"
      >
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder={placeholder}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
        {start.error ? (
          <p className="text-xs text-red-500">
            {start.error instanceof Error ? start.error.message : "Couldn't start the sandbox."}
          </p>
        ) : null}
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            Same repo, new goal — spins up a fresh sandbox.
          </p>
          <button
            type="submit"
            disabled={!goal.trim() || start.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {start.isPending ? "Starting…" : "Run"}
            {!start.isPending ? <ArrowRight className="h-3 w-3" /> : null}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Pick a sensible placeholder based on what we know about this repo. */
function examplePlaceholder(run: RepoRun): string {
  const slug = run.repo_url.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  return `e.g. "Extract the readme highlights from ${slug} and summarize the install steps"`;
}

function StatusPill({ status }: { status: RepoRun["status"] }) {
  const map: Record<RepoRun["status"], { label: string; cls: string; icon: React.ReactNode }> = {
    pending: { label: "Pending", cls: "text-muted-foreground bg-muted", icon: <Clock className="h-3 w-3" /> },
    running: { label: "Running", cls: "text-orange-600 bg-orange-50 dark:bg-orange-950/30", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    succeeded: { label: "Succeeded", cls: "text-green-700 bg-green-50 dark:bg-green-950/30", icon: <CheckCircle className="h-3 w-3" /> },
    failed: { label: "Failed", cls: "text-red-600 bg-red-50 dark:bg-red-950/30", icon: <XCircle className="h-3 w-3" /> },
    blocked: { label: "Blocked", cls: "text-yellow-600 bg-yellow-50 dark:bg-yellow-950/30", icon: <XCircle className="h-3 w-3" /> },
    cancelled: { label: "Cancelled", cls: "text-muted-foreground bg-muted", icon: <XCircle className="h-3 w-3" /> },
  };
  const s = map[status];
  return (
    <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

interface TranscriptEventShape {
  at: string;
  kind: "log" | "agent" | "tool_call" | "error";
  text: string;
}

function TranscriptLine({ ev }: { ev: TranscriptEventShape }) {
  if (ev.kind === "tool_call") return <ToolCallLine text={ev.text} />;
  // session_event "tool_result" comes back through the hydrate layer
  // as kind="error" (the orchestrator's original label). That's a
  // bad name — these are mostly normal tool results. We detect real
  // failures by the exit_code in the parsed JSON.
  if (ev.kind === "error") return <ToolResultLine text={ev.text} />;
  if (ev.kind === "agent") return <AgentLine text={ev.text} />;
  return <LogLine text={ev.text} />;
}

function AgentLine({ text }: { text: string }) {
  return (
    <div className="flex gap-2 text-foreground/90 leading-relaxed">
      <span className="select-none text-foreground/40 shrink-0">▸</span>
      <span className="whitespace-pre-wrap break-words flex-1">{text}</span>
    </div>
  );
}

function LogLine({ text }: { text: string }) {
  return (
    <div className="flex gap-2 text-muted-foreground/70 leading-relaxed">
      <span className="select-none shrink-0 opacity-50">·</span>
      <span className="whitespace-pre-wrap break-words flex-1 font-mono text-[11px]">
        {text}
      </span>
    </div>
  );
}

/**
 * Tool call lines come through as e.g.
 *   `mcp__beevibe-sandbox__sandbox_exec({"cmd":"git clone https://..."})`
 * Raw JSON is unreadable; we extract the tool name + the most useful
 * arg (cmd / path / query / etc.) and render that. The full raw text
 * goes into the title attribute for power users who want it.
 */
function ToolCallLine({ text }: { text: string }) {
  const parsed = parseToolCall(text);
  return (
    <div
      className="flex gap-2 text-blue-500 dark:text-blue-400 leading-relaxed"
      title={text}
    >
      <span className="select-none shrink-0 opacity-60">⚙</span>
      <div className="min-w-0 flex-1">
        <span className="font-mono text-[11px] font-medium">
          {parsed.name}
        </span>
        {parsed.summary ? (
          <span className="ml-2 font-mono text-[11px] text-foreground/70 break-all">
            {parsed.summary}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface ParsedToolCall {
  name: string;
  summary?: string;
}

/** Pull the tool name + an inline summary of its most useful arg. */
function parseToolCall(text: string): ParsedToolCall {
  // Match `tool_name({...json...})`. Tool names from sandbox are
  // long-prefixed (mcp__beevibe-sandbox__sandbox_exec); strip the
  // ns prefix for display.
  const m = text.match(/^([^\s(]+)\((\{[\s\S]*\})\)\s*$/);
  if (!m) {
    return { name: text.length > 80 ? text.slice(0, 77) + "…" : text };
  }
  const fullName = m[1] ?? "";
  const argsJson = m[2] ?? "";
  const name = stripToolNamespace(fullName);

  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return { name };
  }
  if (!args || typeof args !== "object") return { name };
  const a = args as Record<string, unknown>;

  // Pick the most descriptive single arg per known tool. Falls back
  // to a compact json dump for unknowns.
  const candidates = ["cmd", "command", "path", "query", "url", "filename", "content"];
  for (const key of candidates) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) {
      return { name, summary: truncate(v.trim(), 200) };
    }
  }
  const compact = JSON.stringify(a);
  return { name, summary: compact.length > 200 ? compact.slice(0, 197) + "…" : compact };
}

/**
 * Tool result lines come through as e.g.
 *   `→ {"stdout":"...","stderr":"","exit_code":0,"timed_out":false,"duration_seconds":0.376}`
 * We show a short stdout/stderr peek + duration + an exit-code badge.
 * Non-zero exit codes get a red badge so failures stand out.
 */
function ToolResultLine({ text }: { text: string }) {
  const body = text.replace(/^→\s*/, "");
  const parsed = parseToolResult(body);
  return (
    <div className="flex gap-2 text-foreground/70 leading-relaxed">
      <span className="select-none shrink-0 opacity-60">↳</span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {parsed.exitCode !== undefined ? (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-mono",
                parsed.exitCode === 0
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-red-500/15 text-red-600 dark:text-red-400",
              )}
            >
              exit {parsed.exitCode}
            </span>
          ) : null}
          {parsed.durationSeconds !== undefined ? (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {parsed.durationSeconds.toFixed(2)}s
            </span>
          ) : null}
        </div>
        {parsed.body ? (
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-words max-h-32 overflow-y-auto bg-muted/40 rounded px-2 py-1 text-foreground/80">
            {parsed.body}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

interface ParsedToolResult {
  exitCode?: number;
  durationSeconds?: number;
  /** Truncated stdout/stderr/content for the body box. Empty when nothing useful. */
  body?: string;
}

function parseToolResult(body: string): ParsedToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — show as-is, truncated.
    return { body: truncate(body, 1000) };
  }
  if (!parsed || typeof parsed !== "object") {
    return { body: truncate(body, 1000) };
  }
  const r = parsed as Record<string, unknown>;
  const exitCode = typeof r.exit_code === "number" ? r.exit_code : undefined;
  const durationSeconds =
    typeof r.duration_seconds === "number" ? r.duration_seconds : undefined;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const content = typeof r.content === "string" ? r.content : "";

  // Prefer stdout, then content (read_file), then stderr (visible on
  // failures). Empty parts get dropped to keep the box compact.
  const parts: string[] = [];
  if (stdout.trim()) parts.push(truncate(stdout, 1000));
  else if (content.trim()) parts.push(truncate(content, 1000));
  if (stderr.trim()) parts.push("[stderr] " + truncate(stderr, 500));

  // If nothing useful was in stdout/stderr/content, fall back to the
  // raw JSON so the user can still see what came back.
  const bodyText = parts.length > 0 ? parts.join("\n") : truncate(JSON.stringify(r), 500);
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    body: bodyText,
  };
}

/** Strip `mcp__<ns>__` prefix on tool names so they're scannable. */
function stripToolNamespace(name: string): string {
  // mcp__beevibe-sandbox__sandbox_exec → sandbox_exec
  // ToolSearch → ToolSearch
  const m = name.match(/^mcp__[^_]+__([\w-]+)/);
  return m && m[1] ? m[1] : name;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
