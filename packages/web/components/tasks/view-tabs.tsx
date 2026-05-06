"use client";

import { useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSlashFocus } from "@/lib/hooks/use-slash-focus";

// Two real views — kept narrow on purpose. The earlier strip had
// "Active sprint" and "Timeline" tabs that didn't map to any
// concept in the agent-driven task model and "Automate / Sort /
// Filter / Expand / More" toolbar buttons that did nothing. Both
// gone — fake chrome erodes trust faster than it adds polish.
export type TaskView = "all" | "mine";

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
      </div>

      <div className="mb-1.5 shrink-0">
        <SearchBox query={query} onChange={onQueryChange} onFocus={onSearch} />
      </div>
    </div>
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
  const ref = useRef<HTMLInputElement>(null);
  useSlashFocus(ref);
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
      <input
        ref={ref}
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="Search   /"
        aria-label="Search tasks"
        className="h-7 pl-7 pr-2 w-32 focus:w-48 transition-[width] duration-150 text-[12px] rounded bg-transparent border border-transparent hover:border-border focus:border-border focus:bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-0"
      />
    </div>
  );
}
