"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { ExternalLink, X, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { useDismissOnOutside } from "@/lib/hooks/use-dismiss";
import { cn } from "@/lib/utils";
import { ApiNotConfiguredState, LoadFailedState } from "./gate-states";

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

/**
 * The three-branch preamble both peek panels open with — API not
 * configured, still loading, failed to load — and the panel padding each
 * branch sits in.
 *
 * This is `DetailGate` for a panel instead of a page: the branches and
 * their copy are the same (shared via `gate-states.tsx`), only the
 * wrapper differs — `p-4` around an empty state, `p-5 space-y-4` around
 * the skeleton, and nothing around the loaded body, which owns its own
 * padding. Both panels had written all three out by hand, with their own
 * wording for the two failures.
 *
 * `skeleton` stays per-panel for the reason `DetailGate` gives: it
 * mirrors the layout it stands in for, so a shared one would jump on
 * hydration.
 */
export function PanelGate<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  children,
}: {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the panel shows — "task", "agent". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (!isApiConfigured) {
    return (
      <div className="p-4">
        <ApiNotConfiguredState noun={noun} icon={icon} />
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="p-5 space-y-4">{skeleton}</div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="p-4">
        <LoadFailedState noun={noun} id={id} />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}

/**
 * One titled, optionally-counted block in a peek panel's body.
 *
 * Both panels stack their body out of these, and both had their own copy.
 * The copies had drifted apart on spacing (`mt-6` vs `mt-5`) and on the
 * heading's shade (`text-muted-foreground` vs `/85`) without either
 * reading as a deliberate difference; this keeps the task panel's values,
 * which are the later of the two. The `tone` knob — a boxed, amber-ish
 * treatment for a blocked task's reason — came with that copy and is
 * unused by the agent panel.
 *
 * `count` is optional: omitting it renders a bare heading and suppresses
 * the empty-state swap, which is what a section holding a single row
 * (the active-session link) wants.
 */
export function PanelSection({
  title,
  count,
  empty,
  tone,
  children,
}: {
  title: string;
  count?: number;
  /** Shown in place of `children` when `count` is 0. */
  empty?: string;
  tone?: "blocked";
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "mt-5",
        tone === "blocked" &&
          "rounded-md border border-status-blocked/40 bg-status-blocked/5 p-3 -mx-1",
      )}
    >
      <h3
        className={cn(
          "text-[10px] uppercase tracking-wider mb-2 font-semibold",
          tone === "blocked" ? "text-status-blocked" : "text-muted-foreground/85",
        )}
      >
        {title}
        {count !== undefined ? (
          <span className="ml-1 text-muted-foreground/70 tabular-nums font-normal">
            {count}
          </span>
        ) : null}
      </h3>
      {count === 0 && empty ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}
