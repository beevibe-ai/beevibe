"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Shared chip-button + click-outside popover used by the Runtime,
 * Model, and Review-policy chip pickers in the agent list view.
 *
 * Trigger is a `<button>` styled as a status chip; popover content is
 * authored by the caller. Manages open state, click-outside, and
 * Escape. The same click-outside pattern lives in `user-widget.tsx`;
 * this just packages it for reuse so three pickers don't each
 * re-derive it.
 */
export function ChipPopover({
  ariaLabel,
  chipClassName,
  chip,
  children,
  disabled,
  align = "left",
}: {
  ariaLabel: string;
  chipClassName?: string;
  /** Inline content of the chip button (dot + label + caret). */
  chip: ReactNode;
  /** Rendered when the popover is open. Receives a close callback. */
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  /** Which edge the popover aligns to. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs leading-none cursor-pointer transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          chipClassName,
        )}
      >
        {chip}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className={cn(
            "absolute top-full mt-1.5 z-50 min-w-[220px] max-w-[320px] rounded-md py-1 text-sm",
            // Frosted glass surface (defined in globals.css). Adds the
            // backdrop-filter + translucent fill + subtle border so the
            // popover reads as floating above the table without competing
            // with the chips behind it. Includes an opaque fallback for
            // browsers without backdrop-filter support.
            "glass-surface shadow-xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Single row inside a ChipPopover. Composes a menu-item button with a
 * leading slot (dot / icon), a label, an optional sublabel, and an
 * optional trailing checkmark when selected. Keeps the three pickers
 * visually aligned without each re-deriving the row layout.
 */
export function ChipMenuItem({
  selected,
  disabled,
  onClick,
  leading,
  label,
  sublabel,
  trailing,
}: {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  leading?: ReactNode;
  label: ReactNode;
  sublabel?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm cursor-pointer",
        "hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed",
        selected ? "text-foreground" : "text-foreground/85",
      )}
    >
      {leading ? <span className="shrink-0 flex items-center">{leading}</span> : null}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {sublabel ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/80">
          {sublabel}
        </span>
      ) : null}
      {trailing ?? (selected ? <Check /> : null)}
    </button>
  );
}

function Check() {
  return (
    <svg
      className="h-3 w-3 text-muted-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Tiny status dot for chip leading slot. Reusable across pickers. */
export function StatusDot({
  tone,
  glow = true,
}: {
  tone: "green" | "amber" | "gray";
  glow?: boolean;
}) {
  const bg =
    tone === "green"
      ? "bg-emerald-500"
      : tone === "amber"
        ? "bg-amber-500"
        : "bg-muted-foreground/50";
  const ring =
    tone === "green"
      ? "shadow-[0_0_0_3px_rgba(16,185,129,0.18)]"
      : tone === "amber"
        ? "shadow-[0_0_0_3px_rgba(245,158,11,0.20)]"
        : "";
  return (
    <span
      aria-hidden
      className={cn("inline-block h-1.5 w-1.5 rounded-full", bg, glow ? ring : "")}
    />
  );
}

/** Down caret used at the trailing edge of a chip to signal "click to change". */
export function ChipCaret() {
  return (
    <svg
      className="h-3 w-3 text-current opacity-50"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
