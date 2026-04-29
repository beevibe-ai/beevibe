import type { FactType } from "@beevibe/core";
import { cn } from "@/lib/utils";

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
    <span
      className={cn(
        "inline-flex items-center h-5 px-2 rounded text-[11px] font-medium tracking-[0.01em] whitespace-nowrap",
        FACT_TYPE_CLASS[type],
        className,
      )}
    >
      {type}
    </span>
  );
}
