"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { RuntimeChip } from "@/components/agents/pickers/runtime-picker";
import { ModelChip } from "@/components/agents/pickers/model-picker";
import { ReviewPolicyChip } from "@/components/agents/pickers/review-policy-picker";
import type { AgentDisplay } from "@/lib/api/types";

/**
 * Flat table of the caller's agents with inline Runtime / Model /
 * Review policy editors. Each select mutates through the same hooks
 * the detail aside uses, so changing a value here updates everywhere
 * the agent appears (orbit dot, peek panel, detail aside).
 *
 * Clicking a row opens the same peek panel as the orbit canvas — the
 * parent route owns the `?p=<id>` state and renders `AgentDetailPanel`
 * over both views.
 */
export function AgentsListView({
  agents,
  onSelect,
  selectedAgentId,
}: {
  agents: AgentDisplay[];
  onSelect: (agentId: string) => void;
  selectedAgentId: string | undefined;
}) {
  if (agents.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-muted-foreground">
        No agents yet
      </div>
    );
  }

  return (
    <div className="px-6 py-6 overflow-auto h-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border/60">
            <th className="font-medium pb-2 pr-3">Agent</th>
            <th className="font-medium pb-2 pr-3">Hierarchy</th>
            <th className="font-medium pb-2 pr-3 tabular-nums">Sessions</th>
            <th className="font-medium pb-2 pr-3 min-w-[160px]">Runtime</th>
            <th className="font-medium pb-2 pr-3 min-w-[110px]">Model</th>
            <th className="font-medium pb-2 pr-3 min-w-[140px]">Review policy</th>
            <th className="font-medium pb-2 w-8" aria-label="Open detail" />
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedAgentId}
              onSelect={() => onSelect(agent.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentDisplay;
  selected: boolean;
  onSelect: () => void;
}) {
  const initial = agent.display_name.charAt(0).toUpperCase();
  const archived = Boolean(agent.archived_at);

  return (
    <tr
      className={
        "border-b border-border/40 align-middle " +
        (selected ? "bg-secondary/40" : "hover:bg-secondary/20")
      }
    >
      <td className="py-2.5 pr-3">
        <button
          type="button"
          onClick={onSelect}
          className="flex items-center gap-2.5 text-left cursor-pointer"
          title="Open peek panel"
        >
          <Avatar
            initial={initial}
            kind={agent.hierarchy}
            label={agent.display_name}
            specialization={agent.specialization}
            size={28}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-medium truncate">{agent.display_name}</span>
              {archived ? (
                <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  archived
                </span>
              ) : null}
            </div>
            {agent.specialization ? (
              <p className="text-xs text-muted-foreground truncate max-w-[260px]">
                {agent.specialization}
              </p>
            ) : null}
          </div>
        </button>
      </td>
      <td className="py-2.5 pr-3">
        <HierChip hier={agent.hierarchy} />
      </td>
      <td className="py-2.5 pr-3 text-muted-foreground tabular-nums">
        {agent.sessions_count ?? 0}
      </td>
      <td className="py-2.5 pr-3">
        <RuntimeChip agent={agent} />
      </td>
      <td className="py-2.5 pr-3">
        <ModelChip agent={agent} />
      </td>
      <td className="py-2.5 pr-3">
        <ReviewPolicyChip agent={agent} />
      </td>
      <td className="py-2.5">
        <Link
          href={`/agents/${agent.id}`}
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Open full detail page"
          aria-label="Open full detail page"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </td>
    </tr>
  );
}
