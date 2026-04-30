"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { TaskCard } from "./task-card";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/lib/types/tasks";

export type BoardLane = {
  key: "pending" | "in_progress" | "in_review" | "done";
  label: string;
  dot: string;
  count: number;
  tasks: TaskListItem[];
};

export function BoardColumn({ lane, flashTopCard }: { lane: BoardLane; flashTopCard?: boolean }) {
  return (
    <div className="flex flex-col min-w-[280px] w-[300px] shrink-0">
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
        <button
          type="button"
          aria-label={`New task in ${lane.label}`}
          className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {lane.tasks.map((task, i) => (
          <TaskCard key={task.id} task={task} flash={flashTopCard && i === 0} />
        ))}
        <button
          type="button"
          className="flex items-center gap-1.5 h-8 px-2 rounded-md text-[12px] text-muted-foreground/60 hover:text-foreground hover:bg-secondary/50 cursor-pointer transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New task
        </button>
      </div>
    </div>
  );
}
