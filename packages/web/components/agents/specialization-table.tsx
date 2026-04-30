import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fixtureAgents,
  fixtureSpecializationOrder,
  type AgentDisplay,
} from "@/lib/fixtures/agents";

const TIER_CHIP = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  org: "border border-hier-org text-hier-org",
} as const;

const CHANGE_TONE = {
  done: "text-status-done",
  muted: "text-muted-foreground",
} as const;

export function SpecializationTable() {
  const byId = new Map(fixtureAgents.map((a) => [a.id, a]));
  const rows = fixtureSpecializationOrder
    .map((id) => byId.get(id))
    .filter((a): a is AgentDisplay => Boolean(a));

  return (
    <div className="max-w-5xl mx-auto mt-10">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Specialization depth · per agent
        </h2>
        <Link
          href="/memory"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          Browse all facts <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <colgroup>
            <col />
            <col style={{ width: 80 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left px-4 py-2 font-medium">Agent</th>
              <th className="text-left px-3 py-2 font-medium">Tier</th>
              <th className="text-right px-3 py-2 font-medium">Sessions</th>
              <th className="text-right px-3 py-2 font-medium">Facts</th>
              <th className="text-right px-3 py-2 font-medium">Merges</th>
              <th className="text-right px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((agent) => (
              <tr
                key={agent.id}
                className="border-t border-border hover:bg-secondary/30 transition-colors"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/agents/${agent.id}`}
                    className="font-mono text-foreground hover:underline"
                  >
                    {agent.display_name}
                  </Link>
                  {agent.specialization ? (
                    <span className="text-xs text-muted-foreground ml-2">
                      {agent.specialization}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={cn(
                      "inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium",
                      TIER_CHIP[agent.hierarchy],
                    )}
                  >
                    {agent.hierarchy}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {agent.sessions_count ?? 0}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {agent.facts_learned ?? 0}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {agent.merge_events ?? 0}
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 text-right text-[10px]",
                    CHANGE_TONE[agent.weekly_change?.tone ?? "muted"],
                  )}
                >
                  {agent.weekly_change?.label ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-[10px] text-muted-foreground">
        Each agent&rsquo;s depth is bounded — no agent&rsquo;s facts dilute another&rsquo;s. Promoted
        facts (visible to wider scopes) preserve their originating agent_id.{" "}
        <Link
          href="/promotions"
          className="text-foreground/70 hover:text-foreground hover:underline transition-colors"
        >
          14 promotions in last 30d →
        </Link>
      </p>
    </div>
  );
}
