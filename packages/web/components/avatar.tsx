import { cn } from "@/lib/utils";
import type { HierarchyLevel } from "@beevibe/core";

const HIER_BG = {
  ic: "bg-hier-ic/12 text-hier-ic",
  team: "bg-hier-team/12 text-hier-team",
  org: "bg-hier-org/12 text-hier-org",
} as const;

const PRESENCE_BG = {
  running: "bg-status-running",
  idle: "bg-muted-foreground",
  off: "bg-secondary",
} as const;

interface Props {
  initial: string;
  kind: HierarchyLevel | "person";
  size?: number;
  presence?: "running" | "idle" | "off";
  className?: string;
}

export function Avatar({ initial, kind, size = 28, presence, className }: Props) {
  const baseStyle = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.39)) };
  const dotSize = Math.max(6, Math.round(size * 0.32));
  const isPerson = kind === "person";
  return (
    <span className={cn("relative inline-block", className)}>
      <span
        style={baseStyle}
        className={cn(
          "rounded-full inline-flex items-center justify-center font-semibold shrink-0",
          isPerson
            ? "bg-secondary text-foreground border border-border"
            : HIER_BG[kind],
        )}
      >
        {initial}
      </span>
      {presence ? (
        <span
          style={{ width: dotSize, height: dotSize }}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background",
            PRESENCE_BG[presence],
            presence === "running" && "animate-pulse-breathe",
          )}
        />
      ) : null}
    </span>
  );
}
