"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  BookText,
  Bot,
  ChevronDown,
  Clock,
  Layers,
  Search,
  Sparkles,
  Tags,
} from "lucide-react";
import type { MemoryScope } from "@beevibe/core";
import { ScopeTabs, type ScopeFilter } from "@/components/memory/scope-tabs";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { FactTypeTag } from "@/components/fact-type-tag";
import { ScopeChip } from "@/components/scope-chip";
import { RichTextRender } from "@/components/rich-text";
import { useMemoryFacts } from "@/lib/hooks/use-memory";
import { isApiConfigured } from "@/lib/api/config";
import { formatRelativeTime } from "@/lib/format";
import type { MemoryFactDisplay, FactCounts } from "@/lib/types/memory-facts";

const EMPTY_COUNTS: FactCounts = { total: 0, ic: 0, team: 0, org: 0 };

export function MemoryClient() {
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");

  const filterScope: MemoryScope | undefined = scope === "all" ? undefined : scope;
  const { data, isLoading, isError } = useMemoryFacts({ scope: filterScope });

  const counts = useMemo(() => deriveCounts(data ?? []), [data]);
  const filtered = useMemo(() => applyFilter(data ?? [], query), [data, query]);

  return (
    <>
      <ScopeTabs current={scope} counts={counts} onChange={setScope} />

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
          <span className="text-foreground tabular-nums">{filtered.length}</span> facts
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
        >
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
            <Body
              facts={filtered}
              isLoading={isLoading}
              isError={isError}
              hasQuery={query.length > 0}
            />
          </tbody>
        </table>
      </div>
    </>
  );
}

function Body({
  facts,
  isLoading,
  isError,
  hasQuery,
}: {
  facts: MemoryFactDisplay[];
  isLoading: boolean;
  isError: boolean;
  hasQuery: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <tr>
        <td colSpan={5}>
          <EmptyState
            icon={Sparkles}
            title="No facts learned yet"
            description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load memory."
          />
        </td>
      </tr>
    );
  }

  if (isError) {
    return (
      <tr>
        <td colSpan={5}>
          <EmptyState icon={AlertTriangle} title="Couldn't load memory" />
        </td>
      </tr>
    );
  }

  if (isLoading) {
    return (
      <>
        {[0, 1, 2, 3].map((i) => (
          <tr key={i}>
            <td colSpan={5} className="px-3 py-3">
              <Skeleton className="h-5 w-full" />
            </td>
          </tr>
        ))}
      </>
    );
  }

  if (facts.length === 0) {
    return (
      <tr>
        <td colSpan={5}>
          <EmptyState
            icon={Sparkles}
            title={hasQuery ? "No matching facts" : "No facts learned yet"}
            description={
              hasQuery
                ? "Try a different search."
                : "Memory facts appear here as agents accumulate observations."
            }
          />
        </td>
      </tr>
    );
  }

  return (
    <>
      {facts.map((fact) => (
        <tr key={fact.id} className="border-t border-border">
          <td className="px-3 py-3">
            <RichTextRender value={fact.content} />
          </td>
          <td className="px-3 py-3">
            <FactTypeTag type={fact.fact_type} />
          </td>
          <td className="px-3 py-3">
            <ScopeChip scope={fact.scope} />
          </td>
          <td className="px-3 py-3 text-xs text-muted-foreground">{fact.agent_label}</td>
          <td className="px-3 py-3 text-xs text-muted-foreground tabular-nums">
            {formatRelativeTime(fact.created_at)}
          </td>
        </tr>
      ))}
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
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-9 px-3 text-xs rounded-md hover:bg-secondary cursor-pointer transition-colors text-muted-foreground"
    >
      <span>{label}</span>
      <ChevronDown className="h-3 w-3" />
    </button>
  );
}

function deriveCounts(facts: MemoryFactDisplay[]): FactCounts {
  if (facts.length === 0) return EMPTY_COUNTS;
  const counts: FactCounts = { total: facts.length, ic: 0, team: 0, org: 0 };
  for (const f of facts) counts[f.scope] += 1;
  return counts;
}

function applyFilter(facts: MemoryFactDisplay[], query: string): MemoryFactDisplay[] {
  const q = query.trim().toLowerCase();
  if (!q) return facts;
  return facts.filter((f) => {
    const text = typeof f.content === "string" ? f.content : f.content.map(stringify).join(" ");
    return text.toLowerCase().includes(q) || f.agent_label.toLowerCase().includes(q);
  });
}

function stringify(seg: string | { mono: string }): string {
  return typeof seg === "string" ? seg : seg.mono;
}
