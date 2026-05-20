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

  // Pre-process raw transcript: collapse ToolSearch ceremony, drop
  // empty tool results, drop "needs-auth" MCP noise. Keeps the live
  // view focused on real work.
  const cleaned = cleanTranscript(run.transcript);
  const cleanedLen = cleaned.length;

  // "Stick to bottom" UX: auto-scroll on new events, but only if the
  // user is already at (or near) the bottom. If they scrolled up to
  // read an earlier line, leave them where they are.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [cleanedLen, run.status]);

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
          {cleanedLen}
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
          {cleanedLen === 0 ? (
            <p className="text-xs text-muted-foreground">
              {run.status === "pending" ? "Waiting for daemon…" : "No transcript."}
            </p>
          ) : (
            <div className="space-y-1.5 text-xs">
              {cleaned.map((ev, i) => (
                <TranscriptLine key={i} ev={ev} />
              ))}
            </div>
          )}
          <RunOutro run={run} />
        </div>
      </div>
    </div>
  );
}

/**
 * Trim noise out of the raw transcript:
 * 1. Consecutive ToolSearch calls + their (empty) results collapse to
 *    one synthetic log line "Loaded N sandbox tool schemas". The
 *    sandbox MCP tools are known statically; their schema lookup is
 *    ceremony, not signal.
 * 2. Tool results that parse to empty (no exit_code, duration, or body)
 *    are dropped — they render as orphan ↳ markers otherwise.
 * 3. `mcp server …: needs-auth` log lines from the orchestrator are
 *    dropped — they're third-party MCP servers the sandbox child
 *    doesn't use and can't authenticate.
 */
function cleanTranscript(events: TranscriptEventShape[]): TranscriptEventShape[] {
  const out: TranscriptEventShape[] = [];
  let toolSearchPending = 0;
  let lastWasToolSearchCall = false;

  const flushSearch = (): void => {
    if (toolSearchPending > 0) {
      out.push({
        at: "",
        kind: "log",
        text: `Loaded ${toolSearchPending} sandbox tool schema${toolSearchPending === 1 ? "" : "s"}.`,
      });
      toolSearchPending = 0;
    }
  };

  for (const ev of events) {
    // Collapse ToolSearch calls + immediately following empty results.
    if (ev.kind === "tool_call" && /^ToolSearch\b/.test(ev.text)) {
      toolSearchPending += 1;
      lastWasToolSearchCall = true;
      continue;
    }
    if (lastWasToolSearchCall && ev.kind === "error") {
      // Drop the result that pairs with the swallowed ToolSearch call.
      lastWasToolSearchCall = false;
      continue;
    }
    lastWasToolSearchCall = false;

    // Drop "needs-auth" MCP server noise.
    if (ev.kind === "log" && /^mcp server .*: needs-auth$/i.test(ev.text.trim())) {
      continue;
    }

    // Drop empty tool results (no exit_code, no duration, no body).
    if (ev.kind === "error" && isEmptyToolResult(ev.text)) {
      continue;
    }

    // Anything else: flush the ToolSearch count first so position is
    // preserved relative to the next real event.
    flushSearch();
    out.push(ev);
  }
  flushSearch();
  return out;
}

function isEmptyToolResult(text: string): boolean {
  const body = text.replace(/^→\s*/, "").trim();
  if (body === "") return true;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return false;
    const r = parsed as Record<string, unknown>;
    const hasInfo =
      typeof r.exit_code === "number" ||
      typeof r.duration_seconds === "number" ||
      (typeof r.stdout === "string" && r.stdout.trim() !== "") ||
      (typeof r.stderr === "string" && r.stderr.trim() !== "") ||
      (typeof r.content === "string" && r.content.trim() !== "") ||
      (typeof r.host_path === "string" && r.host_path.trim() !== "") ||
      (typeof r.ok === "boolean");
    return !hasInfo;
  } catch {
    return false; // non-JSON body with content — keep it
  }
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

/**
 * Run summary + "what's next" CTA, rendered at the END of the
 * transcript. Two responsibilities:
 *   1. Show the agent's wrap-up summary (last 1-2 agent messages) so
 *      the user doesn't have to scroll back to read what was produced.
 *   2. Surface the Save-as-capability action — the bridge from a
 *      one-off sandbox run to a reusable learned skill that specialist
 *      agents pick up automatically via find_repo.
 */
function RunOutro({ run }: { run: RepoRun }) {
  const [showSave, setShowSave] = useState(false);

  // While running, no outro. The transcript itself is the live view.
  if (run.status === "pending" || run.status === "running") return null;

  // Failure outro: short and red. No save CTA — there's nothing worth
  // saving from a failed run.
  if (run.status !== "succeeded") {
    return (
      <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
        <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-medium text-red-500 mb-0.5 capitalize">{run.status}</p>
          <p className="text-muted-foreground">
            Run didn&apos;t finish. Try a different goal below, or open the artifacts
            link in the header for the partial transcript.
          </p>
        </div>
      </div>
    );
  }

  // Pull the last agent messages — that's where the wrap-up summary
  // and artifact description live (e.g. "Exported. Artifact: foo.md —
  // covers what the repo is…").
  const wrapup = run.transcript
    .filter((e) => e.kind === "agent")
    .slice(-2)
    .map((e) => e.text);

  const alreadyLearned = !!run.learned_skill_id;

  return (
    <>
      <div className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-medium text-foreground">Run complete</span>
          <Link
            href={run.task_id ? `/tasks?p=${run.task_id}` : "#"}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            View artifact files
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {wrapup.length > 0 ? (
          <div className="border-l-2 border-emerald-500/30 pl-3 space-y-1.5">
            {wrapup.map((m, i) => (
              <p key={i} className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">
                {m}
              </p>
            ))}
          </div>
        ) : null}

        <div className="rounded-md border border-border bg-card/60 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <p className="text-xs font-medium">Save as a team capability</p>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
              Step 5 of 6
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Captures this recipe (repo + install steps + invocation) into your
            team&apos;s learned-skill registry. Two things happen automatically
            after you save:
          </p>
          <ul className="text-[11px] text-muted-foreground leading-relaxed list-disc pl-4 space-y-0.5">
            <li>
              <span className="text-foreground">find_repo</span> scores this
              repo at <span className="text-foreground">+50</span> (the highest
              tier) for any specialist agent whose goal matches the pattern you
              name it with — so they pick it up without you re-pasting URLs.
            </li>
            <li>
              A <span className="font-mono text-foreground">SKILL.md</span> lands
              in <span className="font-mono text-foreground">skills/learned/&lt;name&gt;/</span>{" "}
              so Claude Code&apos;s skill auto-discovery surfaces it as a slash
              command for every future agent session.
            </li>
          </ul>
          {alreadyLearned ? (
            <p className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              Already saved as a learned skill.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setShowSave(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Save & name this capability
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
          You&apos;re in the <span className="text-foreground">Save</span> step of the
          capability flow:&nbsp;
          <span className="text-foreground">Discover</span> → Try → Watch →
          Review → <span className="text-foreground">Save</span> → Reuse.
        </p>
      </div>

      {showSave ? (
        <SaveCapabilityModal run={run} onClose={() => setShowSave(false)} />
      ) : null}
    </>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 64);
}

function defaultSkillName(repoUrl: string): string {
  const slug = repoUrl.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  return slugify(slug);
}

/**
 * Pre-fill the goal_pattern with a clean, reusable pattern derived from
 * the actual run. The run.goal includes "Context: ..." and "Straight
 * from my .claude directory" trailers that are specific to this
 * particular Try click and add noise to FTS matching. We strip those
 * down to the first sentence so the pattern is reusable across goals
 * that smell similar.
 *
 * Also folds in the agent's wrap-up summary when it's substantive —
 * that's where the post-run signal lives (what was actually produced).
 */
function deriveDefaultGoalPattern(run: RepoRun): string {
  // Step 1: first sentence of the original goal, minus the Context bit.
  const firstSentence = run.goal
    .split(/[.!?]\s/, 1)[0]
    ?.trim()
    ?? run.goal.trim();
  const cleaned = firstSentence
    .replace(/\s+Context:.*$/i, "")
    .replace(/\s+Straight from.*$/i, "")
    .trim();
  return cleaned || run.goal.trim();
}

/**
 * Alternative pattern derived from the agent's wrap-up message — the
 * last agent line in the transcript. That's where the post-run signal
 * lives (what was actually produced). Offered as an inline swap.
 */
function deriveSummaryGoalPattern(run: RepoRun): string | undefined {
  const lastAgent = [...run.transcript]
    .reverse()
    .find((e) => e.kind === "agent" && e.text.trim() !== "");
  if (!lastAgent) return undefined;
  // Trim to the first sentence and cap length.
  const first = lastAgent.text.split(/[.!?]\s/, 1)[0]?.trim() ?? lastAgent.text;
  return first.length > 0 && first.length < 240 ? first : undefined;
}

/**
 * Modal that captures the user's name + goal pattern and POSTs to
 * /learned-skills. Backend requires the run.status === "succeeded"
 * (already gated by the outro). On success, the modal flips to a
 * confirmation with a link to /capabilities so the user sees the new
 * entry in their "Your capabilities" tab.
 */
function SaveCapabilityModal({
  run,
  onClose,
}: {
  run: RepoRun;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultSkillName(run.repo_url));
  const [goal, setGoal] = useState(deriveDefaultGoalPattern(run));
  const summaryPattern = deriveSummaryGoalPattern(run);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.learnedSkills.create({
        name,
        goal_pattern: goal,
        repo_run_id: run.id,
      }),
    onSuccess: () => setDone(true),
  });

  // Borders on the modal use border-border/40 instead of the default
  // border token. The default reads as too-bright on top of the
  // emerald outro panel + black backdrop; /40 keeps the visual weight
  // anchored on the form fields and buttons, not the chrome.
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
