"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import { useDismissOnOutside } from "@/lib/hooks/use-dismiss";
import { cn } from "@/lib/utils";

/**
 * The Notion-style peek panel shell, shared by the agent peek (over the
 * network canvas) and the task peek (over the kanban).
 *
 * Both are the same surface: a fixed-width `aside` pinned to the right
 * of whatever it overlays, which stays visible and interactive
 * underneath for comparison-by-click; a slim header with an "Open full
 * page" link out to the deep-dive route and a close button; and a
 * scrolling body. Both dismiss on Escape and on a click outside.
 *
 * Callers own the body — the heavier deep-dive (work-product bodies,
 * session transcripts) is what "Open full page" is for, so keep the
 * body single-column and summary-weight.
 */
export function PeekPanel({
  ariaLabel,
  fullPageHref,
  onClose,
  className,
  ignorePan = false,
  children,
}: {
  /** Names the dialog for screen readers, e.g. "Task details". */
  ariaLabel: string;
  /** Route behind "Open full page". */
  fullPageHref: string;
  onClose: () => void;
  /** Extra classes on the aside — stacking context, mostly. */
  className?: string;
  /**
   * Set over a pan-zoom canvas so a drag inside the panel doesn't pan
   * what's underneath it.
   */
  ignorePan?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useDismissOnOutside(panelRef, onClose);

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      data-pan={ignorePan ? "ignore" : undefined}
      className={cn(
        "absolute right-0 top-0 bottom-0 w-[520px] max-w-full bg-card border-l border-border shadow-xl flex flex-col",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 h-11 border-b border-border/60 shrink-0">
        <Link
          href={fullPageHref}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          Open full page
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          title="Close (Esc)"
          className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </aside>
  );
}

/**
 * One label/value cell in a peek panel's footer grid. Both panels close
 * with the same two-column metadata block (id, owner, timestamps), and
 * both had a byte-identical copy of this.
 */
export function PanelFooterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wider text-muted-foreground/70 mb-0.5 text-[10px]">
        {label}
      </div>
      <div className="text-foreground/85 truncate">{children}</div>
    </div>
  );
}
