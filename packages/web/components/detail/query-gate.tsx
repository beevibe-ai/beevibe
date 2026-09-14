"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

export interface QueryGateProps<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what is being shown — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the view. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder. Per-surface rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration. It brings its own padding — only the two message states are
   * wrapped, and they want different insets from the skeleton.
   */
  skeleton: ReactNode;
  /**
   * Applied to the wrapper around the two `EmptyState` branches. The peek
   * panels inset theirs (`p-4`); the full-page shell already has padding
   * and passes nothing.
   */
  stateClassName?: string;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every data-backed surface opens with — API
 * not configured, still loading, failed to load — and nothing else. No
 * shell, so the caller decides what wraps it: {@link DetailGate} puts it
 * in a `DetailShell` for the full-page routes, and the agent/task peek
 * panels render it directly inside a `PeekPanel`.
 *
 * `DetailGate` used to be this logic and the page shell in one component,
 * which is why the two peek panels couldn't reuse it — they needed the
 * branches without the page chrome, so they hand-wrote their own copies
 * and the copy drifted exactly the way `DetailGate` was written to stop:
 * the unconfigured-API message lost the "and run the API server" half,
 * and the fetch error lost the "Check the API server logs" hint. Both
 * messages are derived from `noun` here, so a surface can't word them its
 * own way.
 */
export function QueryGate<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  stateClassName,
  children,
}: QueryGateProps<T>) {
  // Wrapped only when the caller asked for an inset, so the full-page
  // shell's DOM stays exactly what it was before this was extracted.
  const wrap = (state: ReactNode) =>
    stateClassName ? <div className={cn(stateClassName)}>{state}</div> : <>{state}</>;

  if (!isApiConfigured) {
    return wrap(
      <EmptyState
        icon={icon}
        title="API not configured"
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
      />,
    );
  }

  if (query.isLoading) return <>{skeleton}</>;

  // A query can settle without erroring and still hand back nothing (a 404
  // mapped to undefined). That has to land on the error state, not render
  // the body with a missing row.
  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return wrap(
      <EmptyState
        icon={AlertTriangle}
        title={`Couldn't load ${noun}`}
        description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
      />,
    );
  }

  return <>{children(query.data)}</>;
}
