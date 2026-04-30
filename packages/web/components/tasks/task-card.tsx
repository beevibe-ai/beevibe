import Link from "next/link";
import { Ban, XCircle } from "lucide-react";
import type { TaskStatus } from "@beevibe/core";
import { HierChip } from "@/components/hier-chip";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/lib/fixtures/tasks";

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-status-failed",
  medium: "bg-status-review",
  low: "bg-muted-foreground/40",
};

interface DivergentTag {
  label: string;
  tone: "blocked" | "failed" | "muted";
  icon?: typeof Ban;
}

function divergentTag(status: TaskStatus): DivergentTag | null {
  switch (status) {
    case "blocked":
      return { label: "blocked", tone: "blocked", icon: Ban };
    case "failed":
      return { label: "failed", tone: "failed", icon: XCircle };
    case "cancelled":
      return { label: "cancelled", tone: "muted", icon: XCircle };
    case "needs_revision":
      return { label: "needs revision", tone: "blocked" };
    default:
      return null;
  }
}

export function TaskCard({ task, flash }: { task: TaskListItem; flash?: boolean }) {
  const tag = divergentTag(task.status);
  const TagIcon = tag?.icon;
  const time = formatRelativeTime(task.updated_at);
  const actor = task.assignee_label ?? task.creator_label ?? "—";

  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "group block rounded-md bg-background border border-border/80 p-3",
        "hover:border-border hover:bg-secondary/30 transition-colors",
        "shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        flash && "animate-row-flash",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium leading-snug text-foreground line-clamp-2">
            {task.title}
          </div>
          {tag && task.status === "blocked" && task.blocker_reason ? (
            <div className="mt-1 text-[11px] text-status-blocked/90 line-clamp-1">
              {task.blocker_reason}
            </div>
          ) : null}
        </div>
        <span
          className={cn("h-1.5 w-1.5 rounded-full mt-1.5 shrink-0", PRIORITY_DOT[task.priority])}
          aria-label={`priority ${task.priority}`}
        />
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground/80 truncate">{actor}</span>
        {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
        <span className="ml-auto shrink-0 tabular-nums">{time}</span>
      </div>

      {tag ? (
        <div className="mt-2 flex items-center gap-1">
          <span
            className={cn(
              "inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium",
              tag.tone === "blocked" && "bg-status-blocked/15 text-status-blocked",
              tag.tone === "failed" && "bg-status-failed/15 text-status-failed",
              tag.tone === "muted" && "bg-muted text-muted-foreground",
            )}
          >
            {TagIcon ? <TagIcon className="h-3 w-3" /> : null}
            {tag.label}
          </span>
        </div>
      ) : null}
    </Link>
  );
}
