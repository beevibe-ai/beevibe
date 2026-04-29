import Link from "next/link";
import { Building2, Database, KeyRound, Loader2, UsersRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ORG_CHART_H,
  ORG_CHART_VIEWBOX,
  ORG_CHART_W,
  ORG_EDGES,
  fixtureOrgNodes,
  type OrgNode,
} from "@/lib/fixtures/agent-org-layout";

const ICON_MAP: Record<OrgNode["iconName"], LucideIcon> = {
  "building-2": Building2,
  "users-round": UsersRound,
  "key-round": KeyRound,
  database: Database,
};

const HIER_AVATAR_BG = {
  ic: "bg-hier-ic/10 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  org: "bg-hier-org/10 text-hier-org",
} as const;

const HIER_CHIP = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  org: "border border-hier-org text-hier-org",
} as const;

const PRESENCE_DOT = {
  running: "bg-status-running",
  idle: "bg-status-pending",
  off: "bg-secondary",
} as const;

export function OrgChart() {
  return (
    <div className="overflow-x-auto -mx-6 px-6">
      <div
        className="relative mx-auto"
        style={{ width: ORG_CHART_W, height: ORG_CHART_H }}
      >
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={ORG_CHART_VIEWBOX}
          preserveAspectRatio="xMidYMid meet"
        >
          {ORG_EDGES.map((edge, i) => (
            <path
              key={i}
              d={edge.d}
              fill="none"
              stroke="hsl(var(--border))"
              strokeWidth="1.5"
            />
          ))}
        </svg>

        {fixtureOrgNodes.map((node) => {
          const Icon = ICON_MAP[node.iconName];
          return (
            <Link
              key={node.id}
              href={`/agents/${node.id}`}
              className="absolute block w-[200px] h-[100px] bg-card border border-border rounded-lg shadow-sm transition-all duration-150 hover:border-ring hover:shadow-md hover:-translate-y-0.5"
              style={{ left: node.x, top: node.y }}
            >
              <div className="flex items-start gap-3 p-3.5">
                <div className="relative shrink-0">
                  <div
                    className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold",
                      HIER_AVATAR_BG[node.hierarchy],
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <span
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card",
                      PRESENCE_DOT[node.presence],
                      node.presence === "running" && "animate-pulse-breathe",
                    )}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono font-medium text-sm truncate">{node.name}</span>
                    <span
                      className={cn(
                        "inline-flex items-center h-4 px-1 rounded text-[10px] font-medium shrink-0",
                        HIER_CHIP[node.hierarchy],
                      )}
                    >
                      {node.hierarchy}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                    {node.pulse_count ? (
                      <Loader2 className="animate-spin-slow h-3 w-3 text-status-running" />
                    ) : null}
                    <span>{node.meta_line}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-2">{node.footer}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
