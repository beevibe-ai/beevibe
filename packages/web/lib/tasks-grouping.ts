import type { TaskStatus } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

export type Lifecycle = "pending" | "in_progress" | "in_review" | "done";

const LIFECYCLE_OF: Record<TaskStatus, Lifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  revision: "in_progress",
  needs_revision: "in_progress",
  review: "in_review",
  blocked: "in_review",
  done: "done",
  failed: "done",
  cancelled: "done",
};

const LANE_TEMPLATE: { key: Lifecycle; label: string; dot: string }[] = [
  { key: "pending", label: "Pending", dot: "bg-muted-foreground/50" },
  { key: "in_progress", label: "In progress", dot: "bg-status-running" },
  { key: "in_review", label: "In review", dot: "bg-status-review" },
  { key: "done", label: "Done", dot: "bg-status-done" },
];

export function groupTasks(tasks: TaskListItem[]): BoardLane[] {
  const buckets: Record<Lifecycle, TaskListItem[]> = {
    pending: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const t of tasks) buckets[LIFECYCLE_OF[t.status]].push(t);
  return LANE_TEMPLATE.map((l) => ({
    ...l,
    count: buckets[l.key].length,
    tasks: buckets[l.key],
  }));
}
