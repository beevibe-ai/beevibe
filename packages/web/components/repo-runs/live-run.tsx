"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";
import { ChatMarkdown } from "@/components/chat/markdown";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A real, live sandboxed tool run. Polls `/api/tools/runs/[id]` until
 * the orchestrator finishes. Renders transcript events as they stream
 * in and artifacts after the run completes.
 *
 * Backed by Next.js API routes (POC-only deviation from the no-app/api
 * rule — see lib/tools/run-store.ts for context).
 */
export type LiveRunStatus =
  | "starting"
  | "preparing"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed";

interface TranscriptEvent {
  at: string;
  kind: "log" | "agent" | "tool_call" | "error";
  text: string;
}

interface ArtifactDescriptor {
  filename: string;
  title: string;
  size_bytes: number;
  sandbox_path?: string;
  href: string;
}

interface RunResponse {
  run_id: string;
  status: LiveRunStatus;
  repo_url: string;
  goal: string;
  started_at: string;
  finished_at?: string;
  transcript: TranscriptEvent[];
  artifacts: ArtifactDescriptor[];
  error?: string;
}

const STATUS_TONE: Record<LiveRunStatus, { dot: string; text: string; label: string; Icon: typeof CircleCheck }> = {
  starting: { dot: "bg-status-running animate-pulse-breathe", text: "text-status-running", label: "Starting", Icon: Loader2 },
  preparing: { dot: "bg-status-running animate-pulse-breathe", text: "text-status-running", label: "Preparing sandbox", Icon: Loader2 },
  running: { dot: "bg-status-running animate-pulse-breathe", text: "text-status-running", label: "Agent working", Icon: Loader2 },
  succeeded: { dot: "bg-status-done", text: "text-status-done", label: "Done", Icon: CircleCheck },
  blocked: { dot: "bg-status-blocked", text: "text-status-blocked", label: "Couldn't finish", Icon: XCircle },
  failed: { dot: "bg-status-failed", text: "text-status-failed", label: "Failed", Icon: CircleX },
};

export function LiveRunCard({
  runId,
  onDismiss,
}: {
  runId: string;
  onDismiss?: () => void;
}) {
  const { data, isError } = useQuery<RunResponse>({
    queryKey: ["tools", "run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/tools/runs/${runId}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`run ${runId} not found`);
      return (await r.json()) as RunResponse;
    },
    // Poll fast while in flight, slowly when done.
    refetchInterval: (q) => {
      const s = (q.state.data as RunResponse | undefined)?.status;
      if (!s || s === "succeeded" || s === "blocked" || s === "failed") {
        return false;
      }
      return 1500;
    },
  });

  if (isError || !data) {
    return (
      <article className="rounded-lg border border-status-failed/40 bg-card p-4 text-sm text-status-failed">
        Couldn&apos;t load run {runId}. Check the server logs.
      </article>
    );
  }

  return <LiveRunBody run={data} onDismiss={onDismiss} />;
}

function LiveRunBody({
  run,
  onDismiss,
}: {
  run: RunResponse;
  onDismiss?: () => void;
}) {
  const tone = STATUS_TONE[run.status];
  const StatusIcon = tone.Icon;
  const inFlight =
    run.status === "starting" ||
    run.status === "preparing" ||
    run.status === "running";

  const [transcriptOpen, setTranscriptOpen] = useState(inFlight);
  // Auto-expand transcript when in-flight, collapse when finished and
  // there are artifacts to focus on.
  useEffect(() => {
    if (!inFlight && run.artifacts.length > 0) setTranscriptOpen(false);
  }, [inFlight, run.artifacts.length]);

  return (
    <article className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="p-3 flex items-start gap-3 border-b border-border/60">
        <StatusIcon
          className={cn(
            "h-4 w-4 mt-0.5 shrink-0",
            tone.text,
            inFlight ? "animate-spin" : "",
          )}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground/90 leading-snug">
            <span className={cn("font-medium", tone.text)}>{tone.label}</span>
            <span className="text-muted-foreground"> — </span>
            <span className="text-foreground/85">{run.goal}</span>
          </p>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {shortRepoLabel(run.repo_url)} · {formatRelativeTime(run.started_at)}
          </p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        ) : null}
      </header>

      {run.error ? (
        <p className="text-[11px] text-status-failed px-3 py-2 border-b border-border/60">
          {run.error}
        </p>
      ) : null}

      {run.artifacts.length > 0 ? (
        <div className="p-3 border-b border-border/60">
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
            Artifacts
          </h3>
          <ArtifactList artifacts={run.artifacts} />
        </div>
      ) : null}

      <div className="p-3">
        <button
          type="button"
          onClick={() => setTranscriptOpen((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer inline-flex items-center gap-1"
        >
          {transcriptOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {transcriptOpen ? "Hide" : "Show"} agent log
          <span className="text-muted-foreground/70 tabular-nums">
            ({run.transcript.length})
          </span>
        </button>
        {transcriptOpen ? <Transcript events={run.transcript} /> : null}
      </div>
    </article>
  );
}

function Transcript({ events }: { events: TranscriptEvent[] }) {
  return (
    <ul className="mt-2 space-y-1 max-h-[420px] overflow-auto rounded border border-border/40 bg-background/50 p-2 font-mono text-[11px]">
      {events.length === 0 ? (
        <li className="text-muted-foreground/70 italic">…waiting…</li>
      ) : null}
      {events.map((e, i) => {
        const tone =
          e.kind === "error"
            ? "text-status-failed"
            : e.kind === "agent"
              ? "text-foreground/90"
              : e.kind === "tool_call"
                ? "text-status-running"
                : "text-muted-foreground";
        return (
          <li key={i} className={cn("leading-tight whitespace-pre-wrap break-words", tone)}>
            <span className="text-muted-foreground/50 mr-1.5">
              {e.kind === "agent"
                ? "▸"
                : e.kind === "tool_call"
                  ? "·"
                  : e.kind === "error"
                    ? "!"
                    : "—"}
            </span>
            {e.text}
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactList({ artifacts }: { artifacts: ArtifactDescriptor[] }) {
  const [openId, setOpenId] = useState<string | null>(artifacts[0]?.filename ?? null);
  const open = useMemo(
    () => artifacts.find((a) => a.filename === openId) ?? artifacts[0],
    [artifacts, openId],
  );
  return (
    <div className="grid grid-cols-[200px_1fr] gap-3">
      <ul className="space-y-1">
        {artifacts.map((a) => {
          const active = a.filename === open?.filename;
          return (
            <li key={a.filename}>
              <button
                type="button"
                onClick={() => setOpenId(a.filename)}
                className={cn(
                  "w-full text-left flex items-center gap-2 rounded px-2 py-1.5 transition-colors cursor-pointer",
                  active
                    ? "bg-secondary text-foreground"
                    : "hover:bg-secondary/40 text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="flex-1 min-w-0 truncate text-xs">{a.title}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">
                  {formatSize(a.size_bytes)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {open ? <ArtifactBody artifact={open} /> : null}
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: ArtifactDescriptor }) {
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setErr(null);
    fetch(artifact.href, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.href]);

  const ext = artifact.filename.split(".").pop()?.toLowerCase() ?? "";
  return (
    <div className="min-w-0 rounded border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3 mb-2 pb-1.5 border-b border-border/60">
        <span className="text-sm font-medium truncate">{artifact.title}</span>
        <a
          href={artifact.href}
          download={artifact.filename}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          download
        </a>
      </div>
      {err ? (
        <p className="text-[11px] text-status-failed italic">{err}</p>
      ) : content === null ? (
        <p className="text-[11px] text-muted-foreground italic">loading…</p>
      ) : ext === "md" ? (
        <div className="text-foreground/90">
          <ChatMarkdown content={content} />
        </div>
      ) : ext === "json" ? (
        <pre className="text-xs leading-relaxed font-mono text-foreground/85 overflow-x-auto whitespace-pre-wrap">
          {prettyJson(content)}
        </pre>
      ) : (
        <pre className="text-xs leading-relaxed font-mono text-foreground/85 whitespace-pre-wrap break-words">
          {content.length > 4000 ? content.slice(0, 4000) + "\n…[truncated]" : content}
        </pre>
      )}
    </div>
  );
}

function shortRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
