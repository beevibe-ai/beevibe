"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle, Clock, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { api, type RepoRun } from "@/lib/api/client";

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center gap-3 flex-shrink-0">
        <Link
          href="/capabilities"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Capabilities
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium truncate">{run?.goal ?? "Run"}</span>
        {run && <StatusPill status={run.status} />}
        {(run?.status === "pending" || run?.status === "running") && (
          <button
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="ml-auto text-xs text-muted-foreground hover:text-red-500 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && !run && (
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          Run not found.
        </div>
      )}

      {run && (
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row gap-0">
          {/* Transcript */}
          <div className="flex-1 overflow-y-auto p-6 border-b md:border-b-0 md:border-r">
            <h2 className="text-sm font-semibold text-muted-foreground mb-3">Live transcript</h2>
            {run.transcript.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {run.status === "pending" ? "Waiting for daemon…" : "No transcript."}
              </p>
            ) : (
              <div className="space-y-1 font-mono text-xs">
                {run.transcript.map((ev, i) => (
                  <TranscriptLine key={i} ev={ev} />
                ))}
              </div>
            )}
          </div>

          {/* Meta panel */}
          <div className="w-full md:w-72 flex-shrink-0 p-6 space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Goal</p>
              <p className="text-sm">{run.goal}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Repo</p>
              <a
                href={run.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-500 hover:underline break-all"
              >
                {run.repo_url}
              </a>
            </div>
            {run.repo_ref && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Pinned ref</p>
                <p className="text-xs font-mono text-muted-foreground">{run.repo_ref.slice(0, 12)}</p>
              </div>
            )}
            {run.error && (
              <div>
                <p className="text-xs font-medium text-red-500 uppercase tracking-wide mb-1">Error</p>
                <p className="text-xs text-muted-foreground">{run.error}</p>
              </div>
            )}
            {run.task_id && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Task</p>
                <Link
                  href={`/tasks?p=${run.task_id}`}
                  className="text-sm text-blue-500 hover:underline"
                >
                  View artifacts →
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
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
  const kindCls: Record<string, string> = {
    log: "text-muted-foreground",
    agent: "text-foreground",
    tool_call: "text-blue-500 dark:text-blue-400",
    error: "text-red-500",
  };
  const prefix: Record<string, string> = {
    log: "  ",
    agent: "▶ ",
    tool_call: "⚙ ",
    error: "✗ ",
  };
  return (
    <div className={`whitespace-pre-wrap break-all leading-relaxed ${kindCls[ev.kind] ?? "text-muted-foreground"}`}>
      <span className="opacity-40 select-none">{prefix[ev.kind] ?? "  "}</span>
      {ev.text}
    </div>
  );
}
