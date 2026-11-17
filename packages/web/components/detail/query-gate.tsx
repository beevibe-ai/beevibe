"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

export interface QueryGateProps<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the surface. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder. Per-surface rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /**
   * Classes on the wrapper around the not-configured / failed states. Detail
   * pages leave this unset — `DetailShell` already pads them; the peek panels
   * pass `p-4`, since their own padding lives on the loaded body.
   */
  stateClassName?: string;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every data-backed surface opens with — API not
 * configured, still loading, failed to load — and nothing else.
 *
 * Written out by hand on each one before this existed, which is why the copy
 * had drifted: the same condition variously said "run the API server", "run
 * the api server" and "run the MCP server" (one process, three names), and
 * half the surfaces ended the fetch error with "Check the MCP server logs"
 * while the other half dropped the hint. Both messages are derived from
 * `noun` here, so a caller can't word them a fourth way.
 *
 * Detail *pages* use {@link DetailGate}, which is this plus the `DetailShell`
 * all four states share. The peek panels sit inside `PeekPanel` instead and
 * use this directly.
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
  if (!isApiConfigured) {
    return (
      <div className={stateClassName}>
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
        />
      </div>
    );
  }

  if (query.isLoading) return <>{skeleton}</>;

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return (
      <div className={stateClassName}>
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}
