"use client";

import { useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ChipPopover } from "@/components/agents/pickers/chip-popover";
import { cn } from "@/lib/utils";

/**
 * Date picker with a calendar popover. Native <input type="date"> works
 * but its trigger is a tiny browser icon — users don't realise they can
 * click it. This surfaces an explicit calendar button that opens a
 * month grid, with an inline clear affordance.
 *
 * Value contract: YYYY-MM-DD strings. Empty string means "no date".
 * `onClear` is rendered only when provided AND the value is non-empty.
 */
export function DatePicker({
  value,
  onChange,
  onClear,
  ariaLabel = "Pick a date",
  align = "left",
}: {
  /** YYYY-MM-DD, or "" for unset. */
  value: string;
  onChange: (next: string) => void;
  /** If provided, a small × button shows next to the picker when value !== "". */
  onClear?: () => void;
  ariaLabel?: string;
  align?: "left" | "right";
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <ChipPopover
        ariaLabel={ariaLabel}
        align={align}
        // px-2 (vs ChipPopover's default px-2.5) keeps the chip flush with
        // the weeks-selector beside it on the eval header.
        chipClassName="px-2 py-1 text-xs"
        chip={
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            <span className="tabular-nums">
              {value ? formatDisplay(value) : "Pick a date"}
            </span>
          </span>
        }
      >
        {(close) => (
          <CalendarGrid
            value={value || toIsoDate(new Date())}
            onPick={(next) => {
              onChange(next);
              close();
            }}
          />
        )}
      </ChipPopover>
      {onClear && value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear date"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Calendar grid (month view)
// ─────────────────────────────────────────────────────────────────────────

function CalendarGrid({
  value,
  onPick,
}: {
  value: string;
  onPick: (iso: string) => void;
}) {
  // Initial view = the month containing `value`. Subsequent prev/next
  // navigation moves `view` independently; `value` only changes when the
  // user picks a day.
  const [view, setView] = useState<Date>(() => {
    const d = parseIso(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const today = toIsoDate(new Date());
  const monthLabel = view.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const days = monthGrid(view);

  return (
    <div className="px-3 pb-3 pt-2 w-64">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setView(addMonths(view, -1))}
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-medium tabular-nums">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setView(addMonths(view, 1))}
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-[10px] text-muted-foreground mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="text-center py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === view.getMonth();
          const iso = toIsoDate(d);
          const isSelected = iso === value;
          const isToday = iso === today;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(iso)}
              className={cn(
                "h-7 text-xs tabular-nums rounded transition-colors",
                !inMonth && "text-muted-foreground/40",
                inMonth && !isSelected && "text-foreground hover:bg-secondary/60",
                isSelected && "bg-primary text-primary-foreground font-medium",
                isToday && !isSelected && "ring-1 ring-inset ring-border",
              )}
              aria-label={d.toDateString()}
              aria-current={isSelected ? "date" : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onPick(today)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Today
        </button>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {value || "—"}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Date helpers — local components, no UTC drift (matches localDate() in
// packages/api/src/views/memory-activity.ts).
// ─────────────────────────────────────────────────────────────────────────

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIso(s: string): Date {
  // Local-midnight construction to match the rest of the system. Callers
  // are expected to pass a validated YYYY-MM-DD string (the picker funnels
  // empty input through `value || todayIso()` before this runs).
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function monthGrid(view: Date): Date[] {
  // Always render a 6-week grid (42 cells). Start on Sunday so the
  // weekday header row matches.
  const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
  const startDow = firstOfMonth.getDay();
  const start = new Date(view.getFullYear(), view.getMonth(), 1 - startDow);
  return Array.from({ length: 42 }, (_, i) => {
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
  });
}

function formatDisplay(iso: string): string {
  const d = parseIso(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Exported for callers that want "today" without re-deriving. */
export function todayIso(): string {
  return toIsoDate(new Date());
}
