"use client";

import { useRef } from "react";
import { Archive, Search } from "lucide-react";
import { useSlashFocus } from "@/lib/hooks/use-slash-focus";

// Header for /tasks. The earlier strip had "All tasks / My tasks"
// tabs but "My tasks" was a placebo — the backend treated mine = all,
// and the agent-driven task model doesn't have a clean "I own this"
// concept anyway (tasks are agent-assigned). The attention inbox in
// the sidebar replaces the affordance with something real: tasks
// waiting on the human. Header here is just title + archive toggle
// + search.

interface Props {
  onSearch: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  /** Number of failed+cancelled tasks under the current filter. */
  archivedCount: number;
}

export function ViewTabs({
  onSearch,
  query,
  onQueryChange,
  archivedCount,
}: Props) {
  return (
    <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-border/60">
      <h1 className="text-base font-semibold tracking-tight leading-none">Tasks</h1>
      <p className="text-xs text-muted-foreground leading-none flex-1 min-w-0 truncate">
        Work the team is moving through, grouped by status.
      </p>

      <div className="shrink-0 flex items-center gap-2">
        {/* Read-only badge. Failed + cancelled aren't rendered as a
            lane on the board (Done is reserved for "this shipped"); the
            badge just surfaces the count so the user knows the morgue
            isn't empty without dedicating a column to it. */}
        <ArchiveBadge count={archivedCount} />
        <SearchBox query={query} onChange={onQueryChange} onFocus={onSearch} />
      </div>
    </div>
  );
}

function ArchiveBadge({ count }: { count: number }) {
  return (
    <span
      title="Archived (failed + cancelled). Not shown on the board."
      className="h-7 inline-flex items-center gap-1.5 px-2 rounded text-[11px] font-medium text-muted-foreground tabular-nums"
    >
      <Archive className="h-3 w-3" />
      <span>{count} archived</span>
    </span>
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
