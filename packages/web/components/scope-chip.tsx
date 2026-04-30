import type { MemoryScope } from "@beevibe/core";
import { cn } from "@/lib/utils";

const SCOPE_CLASS: Record<MemoryScope, string> = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  // org outline-only — disambiguates from review's amber tint per locked tokens
  org: "border border-hier-org text-hier-org",
};

export function ScopeChip({
  scope,
  className,
}: {
  scope: MemoryScope;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-3.5 px-1 rounded text-[10px] font-medium",
        SCOPE_CLASS[scope],
        className,
      )}
    >
      {scope}
    </span>
  );
}
