"use client";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { ViewTabs, type TaskView } from "@/components/tasks/view-tabs";
import { BoardColumn, type BoardLane } from "@/components/tasks/board-column";
import { EmptyState } from "@/components/empty-state";

const LANES: BoardLane[] = [
  { key: "pending", label: "Pending", dot: "bg-muted-foreground/50", count: 0, tasks: [] },
  { key: "in_progress", label: "In progress", dot: "bg-status-running", count: 0, tasks: [] },
  { key: "in_review", label: "In review", dot: "bg-status-review", count: 0, tasks: [] },
  { key: "done", label: "Done", dot: "bg-status-done", count: 0, tasks: [] },
];

export function TasksClient() {
  const [view, setView] = useState<TaskView>("all");
  const [query, setQuery] = useState("");

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
          {LANES.map((lane) => (
            <BoardColumn key={lane.key} lane={lane} />
          ))}
          <div className="shrink-0 w-2" aria-hidden />
        </div>
        <div className="px-6 pb-8 max-w-md mx-auto">
          <EmptyState
            icon={ListChecks}
            title="No tasks yet"
            description="Create a task to assign work to an agent."
          />
        </div>
      </div>
    </div>
  );
}
