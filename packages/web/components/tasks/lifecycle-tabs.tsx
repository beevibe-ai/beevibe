"use client";

import { CheckCircle2, CircleDot, Inbox, Layers, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export type Lifecycle = "active" | "archive" | "all";

interface Counts {
  active: number;
  archive: number;
  all: number;
  mineToReview: number;
}

interface Props {
  current: Lifecycle;
  counts: Counts;
  onChange: (next: Lifecycle) => void;
  onMineToReview: () => void;
  onNewTask: () => void;
}

const TABS: { key: Lifecycle; label: string; icon: typeof CircleDot }[] = [
  { key: "active", label: "Active", icon: CircleDot },
  { key: "archive", label: "Archive", icon: CheckCircle2 },
  { key: "all", label: "All", icon: Layers },
];

export function LifecycleTabs({
  current,
  counts,
  onChange,
  onMineToReview,
  onNewTask,
}: Props) {
  return (
    <div className="flex items-center gap-5 px-6 pt-8">
      {TABS.map((t) => {
        const active = current === t.key;
        const Icon = t.icon;
        const count = counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={cn(
              "pb-3 -mb-px text-sm border-b-2 inline-flex items-center gap-2 cursor-pointer transition-colors",
              active
                ? "font-semibold border-foreground text-foreground"
                : "font-medium border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {t.label}
            <span className={cn(active ? "text-muted-foreground font-normal" : "font-normal")}>
              {count}
            </span>
          </button>
        );
      })}

      <button
        onClick={onMineToReview}
        className="ml-auto pb-3 -mb-px text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 cursor-pointer"
      >
        <Inbox className="h-4 w-4" />
        Mine to review
        <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[10px] font-medium bg-status-review/15 text-status-review">
          {counts.mineToReview}
        </span>
      </button>

      <button
        onClick={onNewTask}
        className="mb-2 inline-flex items-center gap-1.5 h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-[0.98] transition-all duration-150 cursor-pointer"
      >
        <Plus className="h-3.5 w-3.5" />
        New task
      </button>
    </div>
  );
}
