"use client";

import Link from "next/link";
import { CheckCircle, Clock, Loader2, XCircle } from "lucide-react";
import type { RepoRun } from "@/lib/api/client";
import { cn } from "@/lib/utils";

function repoName(url: string) {
  const parts = url.replace("https://github.com/", "").split("/");
  return parts.slice(0, 2).join("/");
}

function statusIcon(status: RepoRun["status"]) {
  switch (status) {
    case "succeeded":
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case "failed":
    case "blocked":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "cancelled":
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-orange-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

export function RunCard({ run, isFirst = false }: { run: RepoRun; isFirst?: boolean }) {
  const isLive = run.status === "pending" || run.status === "running";
  return (
    <Link
      href={`/capabilities/runs/${run.id}`}
      className={cn(
        "flex items-center gap-3 px-2 -mx-2 py-3 border-b border-border/40 hover:bg-secondary/20 transition-colors",
        isFirst && "border-t border-border/40",
      )}
    >
      <div className="shrink-0">{statusIcon(run.status)}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{run.goal}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {repoName(run.repo_url)}
          {run.error ? (
            <span className="text-red-400"> · {run.error}</span>
          ) : null}
        </p>
      </div>
      {isLive ? (
        <span className="shrink-0 text-xs text-orange-600 dark:text-orange-400 font-medium">
          live →
        </span>
      ) : null}
    </Link>
  );
}
