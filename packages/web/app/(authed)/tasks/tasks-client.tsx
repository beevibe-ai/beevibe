"use client";

import { useMemo, useState } from "react";
import type { TaskStatus } from "@beevibe/core";
import { ViewTabs, type TaskView } from "@/components/tasks/view-tabs";
import { BoardColumn, type BoardLane } from "@/components/tasks/board-column";
import { fixtureTasks, type TaskListItem } from "@/lib/fixtures/tasks";

type LaneKey = BoardLane["key"];

const LANE_OF: Record<TaskStatus, LaneKey | null> = {
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

const STATUS_PRIORITY: Record<TaskStatus, number> = {
  review: 0,
  blocked: 1,
  in_progress: 2,
  revision: 2,
  needs_revision: 2,
  assigned: 3,
  pending: 4,
  done: 5,
  failed: 6,
  cancelled: 7,
};

function sortTasks(tasks: TaskListItem[]): TaskListItem[] {
  return [...tasks].sort((a, b) => {
    const sp = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (sp !== 0) return sp;
    return b.updated_at.getTime() - a.updated_at.getTime();
  });
}

const LANES: { key: LaneKey; label: string; dot: string }[] = [
  { key: "pending", label: "Pending", dot: "bg-muted-foreground/50" },
  { key: "in_progress", label: "In progress", dot: "bg-status-running" },
  { key: "in_review", label: "In review", dot: "bg-status-review" },
  { key: "done", label: "Done", dot: "bg-status-done" },
];

const MY_ID = "per_weijia";

export function TasksClient() {
  const [view, setView] = useState<TaskView>("all");
  const [query, setQuery] = useState("");

  const lanes = useMemo<BoardLane[]>(() => {
    const lower = query.toLowerCase();
    const visible = fixtureTasks.filter((t) => {
      if (lower && !t.title.toLowerCase().includes(lower)) return false;
      if (view === "mine") {
        return t.creator_id === MY_ID || t.assignee_id?.startsWith("agt_");
      }
      if (view === "sprint") {
        const lane = LANE_OF[t.status];
        return lane === "in_progress" || lane === "in_review";
      }
      return true;
    });

    const buckets: Record<LaneKey, TaskListItem[]> = {
      pending: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const t of visible) {
      const lane = LANE_OF[t.status];
      if (lane) buckets[lane].push(t);
    }

    return LANES.map((lane) => ({
      key: lane.key,
      label: lane.label,
      dot: lane.dot,
      count: buckets[lane.key].length,
      tasks: sortTasks(buckets[lane.key]),
    }));
  }, [view, query]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <ViewTabs
        current={view}
        onChange={setView}
        onNewTask={() => {}}
        onSearch={() => {}}
        query={query}
        onQueryChange={setQuery}
      />

      <div className="flex-1 overflow-x-auto overflow-y-auto">
        <div className="group/board flex gap-4 px-6 py-5 min-h-full">
          {lanes.map((lane, idx) => (
            <BoardColumn key={lane.key} lane={lane} flashTopCard={idx === 1} />
          ))}
          <div className="shrink-0 w-2" aria-hidden />
        </div>
      </div>
    </div>
  );
}
