"use client";

import Link from "next/link";
import { Activity, Bot, Sparkles } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Skeleton } from "@/components/skeleton";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/types/agents";

/**
 * Knowledge-graph view of a team: pill-shaped nodes for the team agent
 * and its specialists, connected by solid edges with a small role
 * label. Used on /agents (full size) and on the dashboard's Home page
 * (compact).
 *
 * Three size variants — same visual language, just smaller pills:
 *   - "large"     — full graph (used on /agents).
 *   - "compact"   — embeds (e.g. dashboard summary).
 *   - "satellite" — peer graphs around the caller's own on the
 *                   network canvas. Edge labels are dropped here.
 */
export type TeamOrbitSize = "large" | "compact" | "satellite";

interface OrbitMetrics {
  size: number;
  radius: number;
  teamHeight: number;
  icHeight: number;
  teamAvatar: number;
  icAvatar: number;
  teamMaxWidth: number;
  icMaxWidth: number;
}

const METRICS: Record<TeamOrbitSize, OrbitMetrics> = {
  large: {
    size: 780,
    radius: 290,
    teamHeight: 56,
    icHeight: 48,
    teamAvatar: 40,
    icAvatar: 32,
    teamMaxWidth: 320,
    icMaxWidth: 280,
  },
  compact: {
    size: 580,
    radius: 210,
    teamHeight: 46,
    icHeight: 40,
    teamAvatar: 32,
    icAvatar: 26,
    teamMaxWidth: 240,
    icMaxWidth: 220,
  },
  satellite: {
    size: 400,
    radius: 165,
    teamHeight: 36,
    icHeight: 32,
    teamAvatar: 24,
    icAvatar: 20,
    teamMaxWidth: 180,
    icMaxWidth: 160,
  },
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
 * Click handler for an agent node. When supplied, nodes intercept the
 * default navigation to /agents/:id so callers can open the agent in a
 * peek panel instead of a full route change. The Link href stays
 * intact so right-click "open in new tab" still works.
 */
export type AgentSelectHandler = (agentId: string) => void;

/**
 * Render a single team's knowledge graph. Pass an explicit `agents`
 * array (typed as one team + its IC subordinates); the component picks
 * the top-level agent as the center and arranges the ICs around it.
 * For a self-rendering convenience that fetches the caller's own
 * agents, use <SelfTeamOrbit /> below.
 */
export function TeamOrbit({
  agents,
  size = "large",
  loading = false,
  onSelect,
}: {
  agents: AgentDisplay[] | undefined;
  size?: TeamOrbitSize;
  loading?: boolean;
  onSelect?: AgentSelectHandler;
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
      <Graph team={primary} ics={ics} size={size} onSelect={onSelect} />
      {teams.length > 1 ? (
        <section className="mt-12">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Other teams
          </h2>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {teams.slice(1).map((team) => (
              <li key={team.id}>
                <Pill agent={team} size="compact" role="team" onSelect={onSelect} />
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

function Graph({
  team,
  ics,
  size,
  onSelect,
}: {
  team: AgentDisplay;
  ics: AgentDisplay[];
  size: TeamOrbitSize;
  onSelect?: AgentSelectHandler;
}) {
  const m = METRICS[size];
  const positions = orbitPositions(ics.length, m.radius);
  const showLabels = size === "large";
  const cx = m.size / 2;
  const cy = m.size / 2;

  return (
    <div className="relative mx-auto" style={{ width: m.size, height: m.size }}>
      <svg
        className="absolute inset-0 pointer-events-none"
        viewBox={`0 0 ${m.size} ${m.size}`}
        aria-hidden
      >
        {positions.map((pos, i) => (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + pos.x}
            y2={cy + pos.y}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            className="text-muted-foreground/40"
          />
        ))}
      </svg>

      {showLabels
        ? positions.map((pos, i) => (
            <span
              key={i}
              className="absolute z-[1] text-[9px] uppercase tracking-wider font-medium text-muted-foreground/80 bg-background px-1.5 py-0.5 rounded-full pointer-events-none select-none"
              style={{
                left: `calc(50% + ${pos.x / 2}px)`,
                top: `calc(50% + ${pos.y / 2}px)`,
                transform: "translate(-50%, -50%)",
              }}
            >
              reports to
            </span>
          ))
        : null}

      <div
        className="absolute z-[2]"
        style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}
      >
        <Pill agent={team} size={size} role="team" onSelect={onSelect} />
      </div>

      {ics.map((ic, i) => {
        const pos = positions[i];
        if (!pos) return null;
        return (
          <div
            key={ic.id}
            className="absolute z-[2]"
            style={{
              left: `calc(50% + ${pos.x}px)`,
              top: `calc(50% + ${pos.y}px)`,
              transform: "translate(-50%, -50%)",
            }}
          >
            <Pill agent={ic} size={size} role="ic" onSelect={onSelect} />
          </div>
        );
      })}
    </div>
  );
}

// ── Pill node ────────────────────────────────────────────────────────

// data-pan="ignore" tells the canvas pan handler to skip drag-starts
// that begin on a pill. Without it the click still fires but the
// pointer-down also starts a canvas pan, which feels laggy.
function pillInteractionProps(
  agentId: string,
  onSelect: AgentSelectHandler | undefined,
) {
  if (!onSelect) return { "data-pan": "ignore" as const };
  return {
    "data-pan": "ignore" as const,
    onClick: (e: React.MouseEvent) => {
      // Let cmd/ctrl/middle/shift-clicks fall through so they keep the
      // open-in-new-tab behavior the Link provides.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onSelect(agentId);
    },
  };
}

function Pill({
  agent,
  size,
  role,
  onSelect,
}: {
  agent: AgentDisplay;
  size: TeamOrbitSize;
  role: "team" | "ic";
  onSelect?: AgentSelectHandler;
}) {
  const m = METRICS[size];
  const isTeam = role === "team";
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  const height = isTeam ? m.teamHeight : m.icHeight;
  const avatarSize = isTeam ? m.teamAvatar : m.icAvatar;
  const maxWidth = isTeam ? m.teamMaxWidth : m.icMaxWidth;
  const showStats = size !== "satellite";
  const showSubline = size === "large";

  const textSize =
    size === "large" ? "text-sm" : size === "compact" ? "text-xs" : "text-[11px]";

  return (
    <Link
      href={`/agents/${agent.id}`}
      {...pillInteractionProps(agent.id, onSelect)}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-full border bg-card hover:bg-secondary/60 hover:border-foreground/30 transition-colors shadow-sm cursor-pointer",
        isTeam
          ? "pl-1.5 pr-3.5 border-foreground/15 ring-1 ring-foreground/5"
          : "pl-1.5 pr-3 border-border",
      )}
      style={{ height, maxWidth }}
    >
      <Avatar initial={initial} kind={agent.hierarchy} size={avatarSize} />
      <span className="flex flex-col min-w-0">
        <span
          className={cn(
            "font-semibold leading-tight truncate",
            textSize,
          )}
        >
          {agent.display_name ?? agent.name}
        </span>
        {isTeam ? (
          <span className="text-[9px] uppercase tracking-wider font-mono text-hier-team leading-none mt-1">
            team
          </span>
        ) : showSubline && agent.specialization ? (
          <span className="text-[10px] leading-tight text-muted-foreground truncate mt-0.5">
            {agent.specialization}
          </span>
        ) : null}
      </span>
      {showStats ? (
        <PillStats
          sessions={agent.sessions_count}
          facts={agent.facts_learned}
          compact={size !== "large"}
        />
      ) : null}
    </Link>
  );
}

function PillStats({
  sessions,
  facts,
  compact,
}: {
  sessions: number | undefined;
  facts: number | undefined;
  compact: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2.5 ml-auto pl-2.5 border-l border-border text-muted-foreground tabular-nums shrink-0",
        compact ? "text-[10px]" : "text-[11px]",
      )}
    >
      <span className="inline-flex items-center gap-1">
        <Activity className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden />
        {sessions ?? 0}
      </span>
      <span className="inline-flex items-center gap-1">
        <Sparkles className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden />
        {facts ?? 0}
      </span>
    </span>
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
      className="mx-auto flex flex-col items-center gap-5"
      style={{ width: m.size }}
    >
      <div style={{ width: m.teamMaxWidth, height: m.teamHeight }}>
        <Skeleton className="h-full w-full rounded-full" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: m.icMaxWidth, height: m.icHeight }}>
            <Skeleton className="h-full w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
