import type { HierarchyLevel } from "@beevibe/core";
import { cn } from "@/lib/utils";

const HIER_DOT: Record<HierarchyLevel, string> = {
  ic: "bg-hier-ic",
  team: "bg-hier-team",
  org: "bg-hier-org",
};

export function AgentChip({
  name,
  hierarchy,
  className,
}: {
  name: string;
  hierarchy?: HierarchyLevel;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {hierarchy ? (
        <span className={cn("h-1.5 w-1.5 rounded-full", HIER_DOT[hierarchy])} />
      ) : null}
      <span className="font-mono text-foreground">{name}</span>
    </span>
  );
}
