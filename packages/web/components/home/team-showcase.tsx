"use client";

import Link from "next/link";
import { Bot, Sparkles, Activity } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Skeleton } from "@/components/skeleton";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/types/agents";

/**
 * Top of /dashboard: "Your team" panel that puts agents front-and-center.
 * Beevibe's whole pitch is "team of specialists" — when someone lands on
 * Home, the team should be the first thing they see, not a column of
 * abstract KPI counters.
 *
 * Layout: one row per team agent (the org's top-level agent), with its
 * IC subordinates rendered as a tile grid underneath. ICs visually nest
 * under their team so the hierarchy reads at a glance.
 */
export function TeamShowcase() {
  const { data, isLoading } = useAgents();

  if (isLoading) return <Loading />;
  if (!data || data.length === 0) return null;

  // Group agents by parent: top-level (team / org) at the top, ICs
  // bucketed under their parent's id. Runs once per render — agent
  // lists are O(tens) so the loop is fine on the hot path.
  const tops = data.filter((a) => a.hierarchy !== "ic");
  const subsByParent = new Map<string, AgentDisplay[]>();
  for (const a of data) {
    if (a.hierarchy !== "ic") continue;
    const parent = a.parent_agent_id ?? "__orphan__";
    const arr = subsByParent.get(parent) ?? [];
    arr.push(a);
    subsByParent.set(parent, arr);
  }

  return (
    <section className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold tracking-tight">Your team</h2>
        <Link
          href="/agents"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Manage all →
        </Link>
      </div>
      {tops.map((top) => (
        <TeamGroup
          key={top.id}
          team={top}
          specialists={subsByParent.get(top.id) ?? []}
        />
      ))}
    </section>
  );
}

function TeamGroup({
  team,
  specialists,
}: {
  team: AgentDisplay;
  specialists: AgentDisplay[];
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <TeamHeader team={team} specialistCount={specialists.length} />
      {specialists.length > 0 ? (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-border/60">
          {specialists.map((s) => (
            <SpecialistTile key={s.id} agent={s} />
          ))}
        </ul>
      ) : (
        <div className="px-5 py-6 text-xs text-muted-foreground border-t border-border/60">
          No specialists yet — your team agent will spawn them as the work
          calls for them.
        </div>
      )}
    </div>
  );
}

function TeamHeader({ team, specialistCount }: { team: AgentDisplay; specialistCount: number }) {
  const initial = (team.display_name ?? team.name ?? "?").charAt(0).toUpperCase();
  return (
    <Link
      href={`/agents/${team.id}`}
      className="flex items-center gap-3 px-5 py-4 hover:bg-secondary/30 transition-colors"
    >
      <Avatar initial={initial} kind={team.hierarchy} size={44} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold truncate">{team.display_name ?? team.name}</span>
          <span className="text-[10px] uppercase tracking-wider font-mono px-1 py-px rounded bg-hier-team/15 text-hier-team">
            {team.hierarchy}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {specialistCount === 0
            ? "No specialists yet"
            : `${specialistCount} ${specialistCount === 1 ? "specialist" : "specialists"}`}
          {team.runtime ? <span className="ml-2 text-muted-foreground/70">· {team.runtime}</span> : null}
        </p>
      </div>
      <TeamStat icon={Activity} label="sessions" value={team.sessions_count ?? 0} />
      <TeamStat icon={Sparkles} label="facts" value={team.facts_learned ?? 0} />
    </Link>
  );
}

function TeamStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
}) {
  return (
    <div className="hidden md:flex flex-col items-end shrink-0">
      <div className="flex items-baseline gap-1">
        <Icon className="h-3 w-3 text-muted-foreground/70" />
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
    </div>
  );
}

function SpecialistTile({ agent }: { agent: AgentDisplay }) {
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  return (
    <li>
      <Link
        href={`/agents/${agent.id}`}
        className="flex items-start gap-2.5 bg-card hover:bg-secondary/30 transition-colors px-3.5 py-3 h-full"
      >
        <Avatar initial={initial} kind="ic" size={32} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{agent.display_name ?? agent.name}</div>
          <p
            className={cn(
              "text-[11px] mt-0.5 leading-snug",
              agent.specialization
                ? "text-muted-foreground line-clamp-2"
                : "text-muted-foreground/60 italic",
            )}
          >
            {agent.specialization ?? "No domain set"}
          </p>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground/80 tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Activity className="h-2.5 w-2.5" />
              {agent.sessions_count ?? 0}
            </span>
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-2.5 w-2.5" />
              {agent.facts_learned ?? 0}
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}

function Loading() {
  return (
    <section className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold tracking-tight">Your team</h2>
      </div>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-3">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-border/60">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-card p-3.5 space-y-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-full" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
