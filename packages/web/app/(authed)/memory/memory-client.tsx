"use client";

import { useState } from "react";
import { ChevronDown, Search, ArrowUpDown, BookText, Bot, Clock, Layers, Sparkles, Tags } from "lucide-react";
import { ScopeTabs, type ScopeFilter } from "@/components/memory/scope-tabs";
import { EmptyState } from "@/components/empty-state";

const EMPTY_COUNTS = { total: 0, ic: 0, team: 0, org: 0 };

export function MemoryClient() {
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");

  return (
    <>
      <ScopeTabs current={scope} counts={EMPTY_COUNTS} onChange={setScope} />

      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-lg">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory — semantic + keyword"
            aria-label="Search memory"
            className="w-full h-9 pl-10 pr-3 text-sm rounded-md bg-secondary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-shadow"
          />
        </div>
        <FilterButton label="Type: any" />
        <FilterButton label="Scope: any" />
        <FilterButton label="Agent: any" />
      </div>

      <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
        <span>
          <span className="text-foreground tabular-nums">0</span> facts
        </span>
        <button className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
          <ArrowUpDown className="h-3 w-3" />
          <span>Sort: recently learned</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/60 text-xs uppercase tracking-wider text-muted-foreground">
              <Th icon={<BookText className="h-3.5 w-3.5" />}>Memory</Th>
              <Th icon={<Tags className="h-3.5 w-3.5" />}>Type</Th>
              <Th icon={<Layers className="h-3.5 w-3.5" />}>Scope</Th>
              <Th icon={<Bot className="h-3.5 w-3.5" />}>Agent</Th>
              <Th icon={<Clock className="h-3.5 w-3.5" />}>Created</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5}>
                <EmptyState
                  icon={Sparkles}
                  title="No facts learned yet"
                  description="Memory facts appear here as agents work and the FactPromoter saves observations."
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function Th({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2.5 font-medium">
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {children}
      </span>
    </th>
  );
}

function FilterButton({ label }: { label: string }) {
  return (
    <button className="inline-flex items-center gap-1.5 h-9 px-3 text-xs rounded-md hover:bg-secondary cursor-pointer transition-colors text-muted-foreground">
      <span>{label}</span>
      <ChevronDown className="h-3 w-3" />
    </button>
  );
}
