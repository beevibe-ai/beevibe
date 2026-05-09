"use client";

import Link from "next/link";
import { AlertTriangle, Bot } from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import { isApiConfigured } from "@/lib/api/config";
import { OrgChart } from "@/components/agents/org-chart";
import { SpecializationTable } from "@/components/agents/specialization-table";
import { AgentOnlineDot } from "@/components/agents/agent-online-dot";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import type { AgentDisplay } from "@/lib/types/agents";

export function AgentsClient() {
  const { data, isLoading, isError } = useAgents();
  const count = data?.length ?? 0;

  return (
    <div className="flex-1 overflow-auto">
      <div className="pt-8 pb-12 px-6">
        <div className="max-w-5xl mx-auto mb-8">
          <div className="text-base text-muted-foreground">
            {count > 0 ? (
              <>
                <span className="text-foreground font-medium tabular-nums">{count}</span>{" "}
                {count === 1 ? "agent" : "agents"} in your org.
              </>
            ) : (
              <>
                <span className="text-foreground font-medium">No agents</span> in your org yet.
              </>
            )}
          </div>
        </div>

        <div className="max-w-5xl mx-auto">
          <Body data={data} isLoading={isLoading} isError={isError} />
        </div>
      </div>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
}: {
  data: AgentDisplay[] | undefined;
  isLoading: boolean;
  isError: boolean;
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
            <AgentOnlineDot preferredRuntimeId={agent.preferred_runtime_id} />
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
