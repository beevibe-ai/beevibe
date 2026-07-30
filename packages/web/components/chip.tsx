import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The inline label chip the app uses for short enum-ish values.
 *
 * `HierChip`, `ScopeChip` and `FactTypeTag` were the same component
 * three times: a `<span>` with `inline-flex items-center rounded
 * font-medium`, a `Record<Enum, string>` of colour classes indexed by
 * the value, and a `className` passthrough merged last so call sites can
 * resize. Only the colour map and two size values differed — and
 * `ScopeChip` and `HierChip` didn't even differ in size, they were
 * byte-identical apart from the map.
 *
 * The colour maps stay with their own components: each is a statement
 * about a specific domain enum (which hierarchy tier is outline-only,
 * which fact type is amber) and belongs next to the type it keys on.
 * What's shared is the shape, which is what lives here.
 */

export type ChipSize = "sm" | "md";

const SIZE_CLASS: Record<ChipSize, string> = {
  /** Inline-with-text chips (hierarchy, memory scope). */
  sm: "h-3.5 px-1 text-[10px]",
  /** Standalone tags that carry their own line (fact type). */
  md: "h-5 px-2 text-[11px] tracking-[0.01em] whitespace-nowrap",
};

export function Chip({
  size = "sm",
  tone,
  className,
  children,
}: {
  size?: ChipSize;
  /** Colour classes for this value, e.g. `bg-hier-ic/15 text-hier-ic`. */
  tone: string;
  /**
   * Per-call-site overrides. Merged last, so `cn`'s tailwind-merge lets
   * a caller pass `h-5 px-1.5` to resize a chip without the base size
   * fighting it — which is how `promotions/event-row` and
   * `sessions/briefing-composer` already used `ScopeChip`.
   */
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded font-medium",
        SIZE_CLASS[size],
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}
