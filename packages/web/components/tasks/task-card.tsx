import Link from "next/link";
import { Ban, XCircle } from "lucide-react";
import type { TaskStatus } from "@beevibe/core";
import { HierChip } from "@/components/hier-chip";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/lib/types/tasks";

// We only mark `high` priority on the card. Medium is the default
// (95% of tasks); painting a dot on every card just adds visual noise.
// Low is intentionally invisible — the absence of a dot reads as "not
// urgent" cleanly. The exception is the signal.
const HIGH_PRIORITY_DOT = "bg-status-failed";

interface DivergentTag {
  label: string;
  tone: "blocked" | "failed" | "muted";
  icon?: typeof Ban;
}

function divergentTag(status: TaskStatus): DivergentTag | null {
  switch (status) {
    // `blocked` no longer needs a tag — the Blocked column itself
    // carries that signal. The blocker_reason still surfaces under
    // the title for context.
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

export type TaskSelectHandler = (taskId: string) => void;

export function TaskCard({
  task,
  flash,
  onSelect,
  active,
}: {
  task: TaskListItem;
  flash?: boolean;
  /**
   * If provided, click opens the side-peek panel instead of navigating
   * to /tasks/[id]. Cmd/ctrl/middle-clicks fall through to the Link so
   * "open in new tab" still works for power users.
   */
  onSelect?: TaskSelectHandler;
  /** Card is the currently-open panel target — outline + bg shift. */
  active?: boolean;
}) {
  const tag = divergentTag(task.status);
  const TagIcon = tag?.icon;
  const time = formatRelativeTime(task.updated_at);
  const actor = task.assignee_label ?? task.creator_label ?? "—";

  const onClick = onSelect
    ? (e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onSelect(task.id);
      }
    : undefined;

  return (
    <Link
      href={`/tasks/${task.id}`}
      onClick={onClick}
      className={cn(
        "group block rounded-md bg-background border p-3 transition-colors",
        active
          ? "border-foreground/40 bg-secondary/40"
          : "border-border/80 hover:border-border hover:bg-secondary/30",
        "shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        flash && "animate-row-flash",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium leading-snug text-foreground line-clamp-2">
            {task.title}
          </div>
          {task.status === "blocked" && task.blocker_reason ? (
            <div className="mt-1 text-[11px] text-status-blocked/90 line-clamp-1">
              {task.blocker_reason}
            </div>
          ) : null}
        </div>
        {task.priority === "high" ? (
          <span
            className={cn("h-1.5 w-1.5 rounded-full mt-1.5 shrink-0", HIGH_PRIORITY_DOT)}
            aria-label="high priority"
            title="High priority"
          />
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground/80 truncate">{actor}</span>
        {/* `ic` is the default hierarchy on ~every card; showing it
            makes the chip noise. Surface only the exceptions (team / org)
            so the chip earns its visual weight. */}
        {task.assignee_hierarchy && task.assignee_hierarchy !== "ic" ? (
          <HierChip hier={task.assignee_hierarchy} />
        ) : null}
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
