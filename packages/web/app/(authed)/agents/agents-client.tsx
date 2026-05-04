"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Search } from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import { useSlashFocus } from "@/lib/hooks/use-slash-focus";
import { isApiConfigured } from "@/lib/api/config";
import { OrgChart } from "@/components/agents/org-chart";
import { SpecializationTable } from "@/components/agents/specialization-table";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import type { AgentDisplay } from "@/lib/types/agents";

export function AgentsClient() {
  const { data, isLoading, isError } = useAgents();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  // Filter on name + specialization, case-insensitive substring. Replaces
  // the old sidebar AgentList shortcut: power users used to drill into a
  // specific agent from the rail; now they hit /agents and type-to-find.
  const filtered = useMemo(() => {
    if (!data) return undefined;
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((a) => {
      const name = a.display_name.toLowerCase();
      const spec = a.specialization?.toLowerCase() ?? "";
      return name.includes(q) || spec.includes(q);
    });
  }, [data, query]);

  const totalCount = data?.length ?? 0;
  const filteredCount = filtered?.length ?? 0;
  const isFiltering = query.trim().length > 0;

  return (
    <div className="flex-1 overflow-auto">
      <div className="pt-8 pb-12 px-6">
        <div className="max-w-5xl mx-auto mb-6 flex items-center gap-4">
          <div className="text-sm text-muted-foreground flex-shrink-0">
            {isFiltering ? (
              <>
                <span className="text-foreground font-medium tabular-nums">{filteredCount}</span>{" "}
                of {totalCount}
              </>
            ) : totalCount > 0 ? (
              <>
                <span className="text-foreground font-medium tabular-nums">{totalCount}</span>{" "}
                {totalCount === 1 ? "agent" : "agents"} in your org
              </>
            ) : (
              <>
                <span className="text-foreground font-medium">No agents</span> in your org yet
              </>
            )}
          </div>
          {totalCount > 0 ? (
            <div className="relative flex-1 max-w-xs ml-auto">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find an agent…  ( / )"
                className="w-full h-8 pl-8 pr-2.5 rounded-md border border-border bg-card text-sm focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
              />
            </div>
          ) : null}
        </div>

        <div className="max-w-5xl mx-auto">
          <Body data={filtered} isLoading={isLoading} isError={isError} isFiltering={isFiltering} />
        </div>
      </div>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
  isFiltering,
}: {
  data: AgentDisplay[] | undefined;
  isLoading: boolean;
  isError: boolean;
  isFiltering: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={Bot}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load agents."
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState icon={AlertTriangle} title="Couldn't load agents" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    if (isFiltering) {
      return (
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState icon={Search} title="No agents match" />
        </div>
      );
    }
    return (
      <>
        <OrgChart />
        <SpecializationTable />
      </>
    );
  }

  return (
    <ul className="space-y-2">
      {data.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </ul>
  );
}

function AgentRow({ agent }: { agent: AgentDisplay }) {
  const initial = agent.display_name.charAt(0).toUpperCase();
  return (
    <li>
      <Link
        href={`/agents/${agent.id}`}
        className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 hover:bg-secondary/30 transition-colors"
      >
        <Avatar initial={initial} kind={agent.hierarchy} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{agent.display_name}</span>
            <HierChip hier={agent.hierarchy} />
          </div>
          {agent.specialization ? (
            <p className="text-xs text-muted-foreground truncate mt-0.5">{agent.specialization}</p>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums shrink-0">
          {agent.sessions_count ?? 0} sessions
        </div>
      </Link>
    </li>
  );
}
