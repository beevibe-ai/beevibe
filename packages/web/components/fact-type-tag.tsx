import type { FactType } from "@beevibe/core";
import { Chip } from "@/components/chip";

const FACT_TYPE_CLASS: Record<FactType, string> = {
  belief: "bg-type-belief-bg text-type-belief-fg",
  pattern: "bg-type-pattern-bg text-type-pattern-fg",
  gotcha: "bg-type-gotcha-bg text-type-gotcha-fg",
  preference: "bg-type-preference-bg text-type-preference-fg",
  decision: "bg-type-decision-bg text-type-decision-fg",
};

export function FactTypeTag({
  type,
  className,
}: {
  type: FactType;
  className?: string;
}) {
  return (
    <Chip size="md" tone={FACT_TYPE_CLASS[type]} className={className}>
      {type}
    </Chip>
  );
}
