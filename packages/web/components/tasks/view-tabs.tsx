"use client";

import {
  ArrowUpDown,
  Filter,
  Maximize2,
  MoreHorizontal,
  Plus,
  Search,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type TaskView = "all" | "mine" | "sprint" | "timeline";

// Note: this toolbar previously had a "+ New" button that opened a
// create-task dialog. Removed in #48 — tasks are minted by team agents
// through human-agent conversation, not by the human clicking "+".

interface Props {
  current: TaskView;
  onChange: (next: TaskView) => void;
  onSearch: () => void;
  query: string;
  onQueryChange: (value: string) => void;
}

const VIEWS: { key: TaskView; label: string }[] = [
  { key: "all", label: "All tasks" },
  { key: "mine", label: "My tasks" },
  { key: "sprint", label: "Active sprint" },
  { key: "timeline", label: "Timeline" },
];

export function ViewTabs({ current, onChange, onSearch, query, onQueryChange }: Props) {
  return (
    <div className="flex items-center gap-1 px-6 pt-6 border-b border-border/60">
      <div className="flex items-center gap-0.5 flex-1 min-w-0 -mb-px">
        {VIEWS.map((v) => {
          const active = current === v.key;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => onChange(v.key)}
              className={cn(
                "h-9 px-3 inline-flex items-center gap-1.5 text-[13px] border-b-2 transition-colors cursor-pointer",
                active
                  ? "font-medium border-foreground text-foreground"
                  : "font-normal border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-label="Add view"
          className="h-9 w-7 inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1 mb-1.5 shrink-0">
        <ToolbarIcon label="Sort" icon={ArrowUpDown} />
        <ToolbarIcon label="Filter" icon={Filter} />
        <ToolbarIcon label="Automate" icon={Zap} />
        <SearchBox query={query} onChange={onQueryChange} onFocus={onSearch} />
        <ToolbarIcon label="Expand" icon={Maximize2} />
        <ToolbarIcon label="More" icon={MoreHorizontal} />
      </div>
    </div>
  );
}

function ToolbarIcon({ label, icon: Icon }: { label: string; icon: typeof ArrowUpDown }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function SearchBox({
  query,
  onChange,
  onFocus,
}: {
  query: string;
  onChange: (v: string) => void;
  onFocus: () => void;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
      <input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="Search…"
        aria-label="Search tasks"
        className="h-7 pl-7 pr-2 w-32 focus:w-48 transition-[width] duration-150 text-[12px] rounded bg-transparent border border-transparent hover:border-border focus:border-border focus:bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-0"
      />
    </div>
  );
}

