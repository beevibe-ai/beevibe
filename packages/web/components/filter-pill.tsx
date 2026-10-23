"use client";

import { cn } from "@/lib/utils";

/**
 * One pill in a filter / tab row: the mesh window picker, the mesh
 * activity-feed type filter, the memory scope tabs, and both pill rows on
 * the capabilities page.
 *
 * All five were built from the same markup and the same active/inactive
 * class formula, hand-copied — and had already drifted: three used
 * `hover:bg-secondary`, two `hover:bg-secondary/60`, and the two
 * disabled-pill treatments differed by an opacity step. The formula lives
 * here now; `className` carries only the per-row geometry (height,
 * padding, text size), which is what legitimately differs between rows.
 */
export function FilterPill({
  active,
  disabled,
  onClick,
  className,
  title,
  children,
}: {
  active: boolean;
  /** Renders dimmed and non-interactive — e.g. a filter with no matches. */
  disabled?: boolean;
  onClick: () => void;
  /** Per-row geometry only: height, padding, text size, gap. */
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded transition-colors cursor-pointer",
        active
          ? "bg-secondary text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  );
}
