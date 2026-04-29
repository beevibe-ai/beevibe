"use client";

import { ArrowUpDown, ChevronDown, Search } from "lucide-react";

interface Props {
  query: string;
  onQueryChange: (value: string) => void;
}

function FilterButton({ label }: { label: string }) {
  return (
    <button className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded border border-border bg-background hover:bg-secondary cursor-pointer transition-colors">
      <span className="text-muted-foreground">{label}</span>
      <ChevronDown className="h-3 w-3 text-muted-foreground" />
    </button>
  );
}

export function FilterBar({ query, onQueryChange }: Props) {
  return (
    <div className="flex items-center gap-2 px-6 py-2.5 mt-3">
      <FilterButton label="Status" />
      <FilterButton label="Priority" />
      <FilterButton label="Assignee" />

      <div className="relative flex-1 max-w-md ml-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className="w-full h-7 pl-8 pr-3 text-xs rounded border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 transition-shadow"
        />
      </div>

      <button className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded border border-border bg-background hover:bg-secondary cursor-pointer transition-colors">
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
        <span>Sort: status, then updated</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}
