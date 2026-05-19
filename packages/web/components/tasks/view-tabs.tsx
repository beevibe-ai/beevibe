"use client";

import { useRef } from "react";
import { Archive, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSlashFocus } from "@/lib/hooks/use-slash-focus";
import { PageHeader } from "@/components/page-header";

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
  showArchived: boolean;
  onToggleArchived: () => void;
}

export function ViewTabs({
  onSearch,
  query,
  onQueryChange,
  archivedCount,
  showArchived,
  onToggleArchived,
}: Props) {
  return (
    <PageHeader
      title="Tasks"
      subtitle="Work the team is moving through, grouped by status."
    >
      {/* Archive toggle — always rendered so the affordance is
          discoverable even when there's nothing archived yet. Failed
          and cancelled tasks would otherwise dominate Done, so they're
          hidden by default behind this toggle. */}
      <ArchiveToggle
        count={archivedCount}
        showing={showArchived}
        onToggle={onToggleArchived}
      />
      <SearchBox query={query} onChange={onQueryChange} onFocus={onSearch} />
    </PageHeader>
  );
}

function ArchiveToggle({
  count,
  showing,
  onToggle,
}: {
  count: number;
  showing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={showing}
      title={showing ? "Hide archived (failed + cancelled)" : "Show archived (failed + cancelled)"}
      className={cn(
        "h-7 inline-flex items-center gap-1.5 px-2 rounded text-[11px] font-medium border transition-colors cursor-pointer tabular-nums",
        showing
          ? "border-border bg-secondary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/60",
      )}
    >
      <Archive className="h-3 w-3" />
      <span>{count} archived</span>
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
