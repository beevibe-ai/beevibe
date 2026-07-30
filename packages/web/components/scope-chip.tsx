import type { MemoryScope } from "@beevibe/core";
import { Chip } from "@/components/chip";

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
    <Chip tone={SCOPE_CLASS[scope]} className={className}>
      {scope}
    </Chip>
  );
}
