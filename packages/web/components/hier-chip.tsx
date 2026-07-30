import { Chip } from "@/components/chip";

export type Hierarchy = "ic" | "team" | "org";

const HIER_CLASS: Record<Hierarchy, string> = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-primary text-primary-foreground",
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
    <Chip tone={HIER_CLASS[hier]} className={className}>
      {hier}
    </Chip>
  );
}
