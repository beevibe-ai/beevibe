import Link from "next/link";
import { TaskStatusIcon, statusLabel, statusTextColor } from "@/components/task-status-icon";
import { HierChip } from "@/components/hier-chip";
import { formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/lib/fixtures/tasks";

interface Props {
  task: TaskListItem;
  flash?: boolean;
}

export function TaskRow({ task, flash }: Props) {
  return (
    <li
      className={cn(
        "hover:bg-secondary/40 transition-colors",
        flash && "animate-row-flash",
      )}
    >
      <Link
        href={`/tasks/${task.id}`}
        className="flex items-start gap-3 px-6 py-3 cursor-pointer"
      >
        <TaskStatusIcon status={task.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-medium truncate">{task.title}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {task.priority}
            </span>
          </div>
          <MetaLine task={task} />
        </div>
      </Link>
    </li>
  );
}

function MetaLine({ task }: { task: TaskListItem }) {
  const color = statusTextColor(task.status);
  const time = formatRelativeTime(task.updated_at);
  return (
    <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
      <span className="font-mono">{shortId(task.id)}</span>
      <span>·</span>
      <span className={color}>{statusLabel(task.status)}</span>
      {task.status === "blocked" && task.blocker_reason ? (
        <span className="text-muted-foreground/70">— {task.blocker_reason}</span>
      ) : null}
      {task.status === "pending" && !task.assignee_id ? (
        <span className="text-muted-foreground/70">— no assignee</span>
      ) : null}
      <span>·</span>
      <ActorPart task={task} time={time} />
    </div>
  );
}

function ActorPart({ task, time }: { task: TaskListItem; time: string }) {
  if (task.status === "assigned" && task.assignee_label) {
    return (
      <>
        <span>{time} to</span>
        <span className="font-mono text-foreground">{task.assignee_label}</span>
        {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
      </>
    );
  }
  if (task.status === "pending" && !task.assignee_id) {
    return <span>created {time} by {task.creator_label ?? "—"}</span>;
  }
  if (task.status === "blocked") {
    return (
      <>
        <span>{time} by</span>
        <span className="font-mono text-foreground">
          {task.assignee_label ?? task.creator_label ?? "—"}
        </span>
        {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
      </>
    );
  }
  return (
    <>
      <span>updated {time} by</span>
      <span className="font-mono text-foreground">
        {task.assignee_label ?? task.creator_label ?? "—"}
      </span>
      {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
    </>
  );
}
