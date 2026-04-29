"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Search, ArrowUpDown, BookText, Bot, Clock, Layers, MoreHorizontal, Tags } from "lucide-react";
import { ScopeTabs, type ScopeFilter } from "@/components/memory/scope-tabs";
import { ScopeChip } from "@/components/scope-chip";
import { FactTypeTag } from "@/components/fact-type-tag";
import { formatRelativeTime } from "@/lib/format";
import { fixtureFactCounts, fixtureFacts } from "@/lib/fixtures/memory-facts";
import { cn } from "@/lib/utils";

export function MemoryClient() {
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const lowerQuery = query.toLowerCase();
    return fixtureFacts.filter((f) => {
      if (scope !== "all" && f.scope !== scope) return false;
      if (lowerQuery && !f.content.toLowerCase().includes(lowerQuery)) return false;
      return true;
    });
  }, [scope, query]);

  const allChecked = visible.length > 0 && visible.every((f) => selected.has(f.id));
  const someChecked = visible.some((f) => selected.has(f.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function toggleAll() {
    const next = new Set(selected);
    for (const f of visible) {
      if (allChecked) next.delete(f.id);
      else next.add(f.id);
    }
    setSelected(next);
  }

  return (
    <>
        <ScopeTabs current={scope} counts={fixtureFactCounts} onChange={setScope} />

        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory — semantic + keyword"
              className="w-full h-9 pl-10 pr-3 text-sm rounded-md bg-secondary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-shadow"
            />
          </div>
          <FilterButton label="Type: any" />
          <FilterButton label="Scope: any" />
          <FilterButton label="Agent: any" />
        </div>

        <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
          <span>
            <span className="text-foreground tabular-nums">{visible.length}</span> facts
          </span>
          <button className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
            <ArrowUpDown className="h-3 w-3" />
            <span>Sort: recently learned</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>

        <div className="overflow-hidden rounded-md">
          <table className="w-full text-sm">
            <colgroup>
              <col style={{ width: 40 }} />
              <col />
              <col style={{ width: 110 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 40 }} />
            </colgroup>
            <thead>
              <tr className="bg-secondary/60 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="text-left px-3 py-2.5 font-medium">
                  <Checkbox
                    checked={allChecked}
                    indeterminate={!allChecked && someChecked}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <Th icon={<BookText className="h-3.5 w-3.5" />}>Memory</Th>
                <Th icon={<Tags className="h-3.5 w-3.5" />}>Type</Th>
                <Th icon={<Layers className="h-3.5 w-3.5" />}>Scope</Th>
                <Th icon={<Bot className="h-3.5 w-3.5" />}>Agent</Th>
                <Th icon={<Clock className="h-3.5 w-3.5" />}>Created</Th>
                <th className="text-left px-3 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {visible.map((fact) => (
                <tr key={fact.id} className="hover:bg-secondary/30 transition-colors">
                  <td className="px-3 py-3 align-top">
                    <Checkbox
                      checked={selected.has(fact.id)}
                      onChange={() => toggle(fact.id)}
                      aria-label="Select row"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <button className="block line-clamp-2 font-medium hover:underline cursor-pointer text-left">
                      {fact.content}
                    </button>
                    <div className="mt-1 text-[10px] text-muted-foreground font-mono">
                      {fact.source_session_count} session
                      {fact.source_session_count === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <FactTypeTag type={fact.fact_type} />
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <ScopeChip scope={fact.scope} className="h-4 px-1.5 text-[10px]" />
                  </td>
                  <td className="px-3 py-3 align-middle font-mono text-xs">{fact.agent_label}</td>
                  <td className="px-3 py-3 align-middle text-xs text-muted-foreground tabular-nums">
                    {formatRelativeTime(fact.created_at)}
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <button className="h-6 w-6 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected.size > 0 ? (
          <div className="mt-3 flex items-center gap-3 px-3 py-2 rounded-md bg-secondary text-sm">
            <span className="text-foreground tabular-nums font-medium">{selected.size}</span>
            <span className="text-muted-foreground">selected</span>
            <button className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs hover:bg-background transition-colors">
              Promote
            </button>
            <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs hover:bg-background transition-colors">
              Demote
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing <span className="text-foreground">1–{visible.length}</span> of{" "}
            <span className="text-foreground">{fixtureFactCounts.total}</span>
          </span>
          <Pagination />
        </div>

        <div className="mt-10 text-xs text-muted-foreground">
          mock · Mem0 OpenMemory pattern: table view, bulk-selectable rows, type/scope/agent columns.
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

function Checkbox({
  checked,
  indeterminate,
  onChange,
  ...props
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange">) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate ?? false;
      }}
      className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
      {...props}
    />
  );
}

function Pagination() {
  return (
    <div className="flex items-center gap-1">
      <button
        disabled
        className="h-7 w-7 rounded inline-flex items-center justify-center hover:bg-secondary cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={cn(
            "h-7 min-w-7 px-2 rounded cursor-pointer transition-colors",
            n === 1 ? "text-foreground bg-secondary font-medium" : "hover:bg-secondary",
          )}
        >
          {n}
        </button>
      ))}
      <button className="h-7 w-7 rounded inline-flex items-center justify-center hover:bg-secondary cursor-pointer transition-colors">
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
