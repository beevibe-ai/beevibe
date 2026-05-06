"use client";

import Link from "next/link";
import { Activity, Bot, Sparkles } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Skeleton } from "@/components/skeleton";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/types/agents";

/**
 * Visual orbit of the user's team — team agent at the center, IC
 * specialists arranged around them on a dashed ring with thin
 * connection lines. Used on /agents (full size) and on the
 * dashboard's Home page (compact). Game-card layout reads as
 * "trading cards of agents" rather than a list of rows.
 *
 * Two size variants:
 *   - "large"  — 640×640, full orbit. /agents uses this.
 *   - "compact" — 480×480, smaller cards. Dashboard summary uses this.
 */
export type TeamOrbitSize = "large" | "compact";

interface OrbitMetrics {
  size: number;
  radius: number;
  teamCard: number;
  icCard: number;
  teamAvatar: number;
  icAvatar: number;
}

const METRICS: Record<TeamOrbitSize, OrbitMetrics> = {
  large: { size: 640, radius: 220, teamCard: 180, icCard: 140, teamAvatar: 64, icAvatar: 44 },
  compact: { size: 480, radius: 160, teamCard: 140, icCard: 110, teamAvatar: 48, icAvatar: 36 },
};

interface Position {
  x: number;
  y: number;
}

function orbitPositions(count: number, radius: number): Position[] {
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}

/**
 * Render a single team's orbit. Pass an explicit `agents` array (typed
 * as one team + its IC subordinates); the component picks the
 * top-level agent as the center and arranges the ICs around it. For a
 * self-rendering convenience that fetches the caller's own agents,
 * use <SelfTeamOrbit /> below.
 */
export function TeamOrbit({
  agents,
  size = "large",
  loading = false,
}: {
  agents: AgentDisplay[] | undefined;
  size?: TeamOrbitSize;
  loading?: boolean;
}) {
  if (loading) return <OrbitSkeleton size={size} />;
  if (!agents || agents.length === 0) return <OrbitEmpty />;

  const teams = agents.filter((a) => a.hierarchy !== "ic");
  const primary = teams[0];
  if (!primary) return <OrbitEmpty />;

  const ics = agents.filter(
    (a) => a.hierarchy === "ic" && a.parent_agent_id === primary.id,
  );

  return (
    <div>
      <Orbit team={primary} ics={ics} size={size} />
      {teams.length > 1 ? (
        <section className="mt-12">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Other teams
          </h2>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {teams.slice(1).map((team) => (
              <li key={team.id}>
                <SpecialistCard agent={team} size="compact" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Self-rendering convenience — fetches the caller's own agents and
 * passes them to TeamOrbit. Used on the dashboard's compact summary.
 */
export function SelfTeamOrbit({ size = "large" }: { size?: TeamOrbitSize }) {
  const { data, isLoading } = useAgents();
  return <TeamOrbit agents={data} size={size} loading={isLoading} />;
}

function Orbit({
  team,
  ics,
  size,
}: {
  team: AgentDisplay;
  ics: AgentDisplay[];
  size: TeamOrbitSize;
}) {
  const m = METRICS[size];
  const positions = orbitPositions(ics.length, m.radius);

  return (
    <div className="relative mx-auto" style={{ width: m.size, height: m.size }}>
      <svg
        className="absolute inset-0 pointer-events-none"
        viewBox={`0 0 ${m.size} ${m.size}`}
        aria-hidden
      >
        <circle
          cx={m.size / 2}
          cy={m.size / 2}
          r={m.radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 6"
          className="text-border"
        />
        {positions.map((pos, i) => (
          <line
            key={i}
            x1={m.size / 2}
            y1={m.size / 2}
            x2={m.size / 2 + pos.x}
            y2={m.size / 2 + pos.y}
            stroke="currentColor"
            strokeWidth={1}
            className="text-border/70"
          />
        ))}
      </svg>

      <div
        className="absolute"
        style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}
      >
        <TeamCard agent={team} size={size} />
      </div>

      {ics.map((ic, i) => {
        const pos = positions[i];
        if (!pos) return null;
        return (
          <div
            key={ic.id}
            className="absolute"
            style={{
              left: `calc(50% + ${pos.x}px)`,
              top: `calc(50% + ${pos.y}px)`,
              transform: "translate(-50%, -50%)",
            }}
          >
            <SpecialistCard agent={ic} size={size} />
          </div>
        );
      })}
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────

function TeamCard({ agent, size }: { agent: AgentDisplay; size: TeamOrbitSize }) {
  const m = METRICS[size];
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex flex-col items-center text-center rounded-2xl border border-border bg-card hover:bg-secondary/40 hover:border-foreground/30 transition-colors p-4 shadow-sm"
      style={{ width: m.teamCard }}
    >
      <Avatar initial={initial} kind={agent.hierarchy} size={m.teamAvatar} />
      <div className="mt-3 w-full min-w-0">
        <div
          className={cn(
            "font-semibold truncate",
            size === "large" ? "text-sm" : "text-xs",
          )}
        >
          {agent.display_name ?? agent.name}
        </div>
        <div className="mt-0.5 inline-block text-[10px] uppercase tracking-wider font-mono px-1 py-px rounded bg-hier-team/15 text-hier-team">
          {agent.hierarchy}
        </div>
      </div>
      <CardStats sessions={agent.sessions_count} facts={agent.facts_learned} />
    </Link>
  );
}

function SpecialistCard({
  agent,
  size,
}: {
  agent: AgentDisplay;
  size: TeamOrbitSize;
}) {
  const m = METRICS[size];
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex flex-col items-center text-center rounded-xl border border-border bg-card hover:bg-secondary/40 hover:border-foreground/30 transition-colors p-3"
      style={{ width: m.icCard }}
    >
      <Avatar initial={initial} kind={agent.hierarchy} size={m.icAvatar} />
      <div className="mt-2 w-full min-w-0">
        <div className="text-xs font-semibold truncate leading-tight">
          {agent.display_name ?? agent.name}
        </div>
        {size === "large" ? (
          <p
            className={cn(
              "mt-1 text-[11px] leading-snug line-clamp-2",
              agent.specialization ? "text-muted-foreground" : "text-muted-foreground/60 italic",
            )}
          >
            {agent.specialization ?? "No domain set"}
          </p>
        ) : null}
      </div>
      <CardStats
        sessions={agent.sessions_count}
        facts={agent.facts_learned}
        compact
      />
    </Link>
  );
}

function CardStats({
  sessions,
  facts,
  compact,
}: {
  sessions: number | undefined;
  facts: number | undefined;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-3 w-full flex items-center justify-center gap-3 text-muted-foreground/80 tabular-nums",
        compact ? "text-[10px]" : "text-[11px]",
      )}
    >
      <span className="inline-flex items-center gap-1">
        <Activity className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        {sessions ?? 0}
      </span>
      <span className="inline-flex items-center gap-1">
        <Sparkles className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
        {facts ?? 0}
      </span>
    </div>
  );
}

// ── Empty / loading ──────────────────────────────────────────────────

function OrbitEmpty() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-sm text-muted-foreground">
      <Bot className="h-6 w-6 mb-2 text-muted-foreground/60" />
      <p className="font-medium text-foreground">No agents yet</p>
      <p className="mt-1 max-w-sm text-center leading-relaxed">
        Your team agent will spawn specialists when you point it at a codebase.
      </p>
    </div>
  );
}

function OrbitSkeleton({ size }: { size: TeamOrbitSize }) {
  const m = METRICS[size];
  return (
    <div
      className="mx-auto flex flex-col items-center gap-6"
      style={{ width: m.size }}
    >
      <div style={{ width: m.teamCard, height: m.teamCard }}>
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ width: m.icCard, height: m.icCard }}>
            <Skeleton className="h-full w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
