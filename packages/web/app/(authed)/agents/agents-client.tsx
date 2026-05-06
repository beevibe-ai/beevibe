"use client";

import Link from "next/link";
import { AlertTriangle, Bot, Activity, Sparkles } from "lucide-react";
import { useAgents } from "@/lib/hooks/use-agents";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { Avatar } from "@/components/avatar";
import { cn } from "@/lib/utils";
import type { AgentDisplay } from "@/lib/types/agents";

/**
 * /agents — visual orbit of the user's team.
 *
 * The previous list was redundant: the same flat agent list shows up in
 * the sidebar's "Your team" section and as tiles on the dashboard's
 * TeamShowcase. A third copy added no value.
 *
 * The orbit reframes the surface around the *relationship*: team agent
 * at the center, IC specialists arranged at evenly-spaced angles around
 * it. Connection lines drawn from center to each IC make the
 * parent-child structure visible without a tree widget.
 */
export function AgentsClient() {
  const { data, isLoading, isError } = useAgents();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pt-8 pb-12 px-6">
        <Body data={data} isLoading={isLoading} isError={isError} />
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
      <EmptyShell
        icon={Bot}
        title="API not configured"
        description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load agents."
      />
    );
  }
  if (isError) return <EmptyShell icon={AlertTriangle} title="Couldn't load agents" />;
  if (isLoading) return <OrbitSkeleton />;
  if (!data || data.length === 0) {
    return (
      <EmptyShell
        icon={Bot}
        title="No agents yet"
        description="Your team agent will spawn specialists when you point it at a codebase."
      />
    );
  }

  return <TeamOrbit agents={data} />;
}

// ── Layout constants ─────────────────────────────────────────────────

// Container is a square — the orbit needs equal width/height to draw
// circles. Sized so the team card sits at the center with comfortable
// breathing room around it for the IC ring.
const ORBIT_SIZE = 640;
const ORBIT_RADIUS = 220;
const TEAM_CARD_SIZE = 180;
const IC_CARD_SIZE = 140;

interface Position {
  x: number;
  y: number;
}

/**
 * Compute (x, y) for each IC around a circle. First agent goes to
 * 12 o'clock; subsequent agents fan clockwise at evenly-spaced angles.
 */
function orbitPositions(count: number, radius: number): Position[] {
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
}

// ── Orbit ────────────────────────────────────────────────────────────

function TeamOrbit({ agents }: { agents: AgentDisplay[] }) {
  // Pick the primary team agent — the first non-IC. Multiple top-level
  // agents are rare in practice (one team, sometimes one org parent);
  // additional teams render as a second-row strip below.
  const teams = agents.filter((a) => a.hierarchy !== "ic");
  const primary = teams[0];

  if (!primary) {
    // Pathological: only ICs, no team. Shouldn't happen in normal data
    // but render gracefully anyway.
    return (
      <ul className="grid grid-cols-3 gap-3">
        {agents.map((a) => (
          <li key={a.id}>
            <SpecialistCard agent={a} />
          </li>
        ))}
      </ul>
    );
  }

  const ics = agents.filter(
    (a) => a.hierarchy === "ic" && a.parent_agent_id === primary.id,
  );
  const positions = orbitPositions(ics.length, ORBIT_RADIUS);
  const otherTeams = teams.slice(1);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Your team</h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-prose">
          {primary.display_name ?? primary.name} at the center, specialists
          orbiting around them. Click any agent to drill into their persona,
          domain, and recent sessions.
        </p>
      </header>

      <div
        className="relative mx-auto"
        style={{ width: ORBIT_SIZE, height: ORBIT_SIZE }}
      >
        {/* SVG orbit ring + connection lines. Decorative — picks up the
            structure without forcing a Tree widget. */}
        <svg
          className="absolute inset-0 pointer-events-none"
          viewBox={`0 0 ${ORBIT_SIZE} ${ORBIT_SIZE}`}
          aria-hidden
        >
          <circle
            cx={ORBIT_SIZE / 2}
            cy={ORBIT_SIZE / 2}
            r={ORBIT_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 6"
            className="text-border"
          />
          {positions.map((pos, i) => (
            <line
              key={i}
              x1={ORBIT_SIZE / 2}
              y1={ORBIT_SIZE / 2}
              x2={ORBIT_SIZE / 2 + pos.x}
              y2={ORBIT_SIZE / 2 + pos.y}
              stroke="currentColor"
              strokeWidth={1}
              className="text-border/70"
            />
          ))}
        </svg>

        {/* Center: team card */}
        <div
          className="absolute"
          style={{
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <TeamCard agent={primary} size={TEAM_CARD_SIZE} />
        </div>

        {/* Ring: ICs at orbit positions */}
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
              <SpecialistCard agent={ic} size={IC_CARD_SIZE} />
            </div>
          );
        })}
      </div>

      {/* Other teams (org-level peers, second team agent on the same
          person, etc.) appear in a strip below — they're rare today but
          rendered if they exist so they're not silently dropped. */}
      {otherTeams.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Other teams
          </h2>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {otherTeams.map((team) => (
              <li key={team.id}>
                <SpecialistCard agent={team} size={IC_CARD_SIZE} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────

/**
 * Team agent card — bigger, more emphasis. Avatar on top, name + role
 * below, sessions / facts stats at the bottom. Game-card layout so the
 * eye lands on identity first.
 */
function TeamCard({ agent, size }: { agent: AgentDisplay; size: number }) {
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex flex-col items-center text-center rounded-2xl border border-border bg-card hover:bg-secondary/40 hover:border-foreground/30 transition-colors p-4 shadow-sm"
      style={{ width: size }}
    >
      <Avatar initial={initial} kind={agent.hierarchy} size={64} />
      <div className="mt-3 w-full min-w-0">
        <div className="text-sm font-semibold truncate">
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

/**
 * IC specialist card — smaller, subtler. Same vocabulary as TeamCard
 * (avatar / name / domain / stats) so the eye treats them as a family.
 */
function SpecialistCard({ agent, size }: { agent: AgentDisplay; size?: number }) {
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex flex-col items-center text-center rounded-xl border border-border bg-card hover:bg-secondary/40 hover:border-foreground/30 transition-colors p-3"
      style={size ? { width: size } : undefined}
    >
      <Avatar initial={initial} kind={agent.hierarchy} size={44} />
      <div className="mt-2 w-full min-w-0">
        <div className="text-xs font-semibold truncate leading-tight">
          {agent.display_name ?? agent.name}
        </div>
        <p
          className={cn(
            "mt-1 text-[11px] leading-snug line-clamp-2",
            agent.specialization ? "text-muted-foreground" : "text-muted-foreground/60 italic",
          )}
        >
          {agent.specialization ?? "No domain set"}
        </p>
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

// ── Empty / loading shells ───────────────────────────────────────────

function EmptyShell({
  icon,
  title,
  description,
}: {
  icon: typeof Bot;
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border">
      <EmptyState icon={icon} title={title} description={description} />
    </div>
  );
}

function OrbitSkeleton() {
  return (
    <div className="flex flex-col items-center gap-6">
      <Skeleton className="h-44 w-44 rounded-2xl" />
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-32 w-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
