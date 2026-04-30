import { cn } from "@/lib/utils";

export type Hierarchy = "ic" | "team" | "org";

const HIER_CLASS: Record<Hierarchy, string> = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  // org is OUTLINE-only — disambiguates from review (amber tint)
  org: "border border-hier-org text-hier-org",
};

export function HierChip({
  hier,
  className,
}: {
  hier: Hierarchy;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-3.5 px-1 rounded text-[10px] font-medium",
        HIER_CLASS[hier],
        className,
      )}
    >
      {hier}
    </span>
  );
}
