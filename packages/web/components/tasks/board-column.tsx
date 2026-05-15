"use client";

import { MoreHorizontal } from "lucide-react";
import { TaskCard, type TaskSelectHandler } from "./task-card";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/lib/types/tasks";
import type { Lifecycle } from "@/lib/tasks-grouping";

export type BoardLane = {
  key: Lifecycle;
  label: string;
  dot: string;
  count: number;
  tasks: TaskListItem[];
};

// Tasks are minted by team agents through human-agent conversation, not by
// the human clicking "+" in a kanban column. The original "+ New task"
// affordance was removed in #48 — when the human chat surface lands, the
// "create" entry point lives there.

export function BoardColumn({
  lane,
  flashTopCard,
  onSelectTask,
  activeTaskId,
}: {
  lane: BoardLane;
  flashTopCard?: boolean;
  onSelectTask?: TaskSelectHandler;
  activeTaskId?: string;
}) {
  return (
    <div className="flex flex-col flex-1 min-w-[220px]">
      <div className="flex items-center gap-2 h-8 px-1 mb-2">
        <span
          className={cn("inline-flex items-center gap-1.5 px-1.5 h-5 rounded text-[11px] font-medium")}
        >
          <span className={cn("h-2 w-2 rounded-full", lane.dot)} aria-hidden />
          <span className="text-foreground">{lane.label}</span>
          <span className="text-muted-foreground/70 tabular-nums">{lane.count}</span>
        </span>
        <button
          type="button"
          aria-label={`More actions for ${lane.label}`}
          className="ml-auto h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-secondary opacity-0 group-hover/board:opacity-100 transition-opacity cursor-pointer"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {lane.tasks.map((task, i) => (
          <TaskCard
            key={task.id}
            task={task}
            flash={flashTopCard && i === 0}
            onSelect={onSelectTask}
            active={activeTaskId === task.id}
          />
        ))}
      </div>
    </div>
  );
}
