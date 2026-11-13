"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

/**
 * The four-branch preamble every surface that renders one fetched row
 * opens with: API not configured, still loading, failed to load, loaded.
 *
 * `DetailGate` had this for the full-page detail routes, but it bakes in
 * `DetailShell`, so the two Notion-style peek panels — which need the
 * same four branches inside a much narrower wrapper — could not reach
 * it and wrote the preamble out by hand instead. The copy had already
 * drifted apart as a result: the panels said "Set NEXT_PUBLIC_BV_API_URL
 * to load this agent." where the pages said "…and run the API server to
 * load this agent.", and the panels dropped the "Check the API server
 * logs." hint from the fetch-error state entirely.
 *
 * So the branch logic and both message templates live here, and the
 * wrapper is the only thing a caller varies: {@link DetailGate} passes
 * `DetailShell`, `PanelGate` passes the panel's padding. A caller can't
 * word either message a third way, which is the whole point.
 */
export interface GateQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface QueryGateProps<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the surface. */
  query: GateQuery<T>;
  /**
   * Loading placeholder. Per-caller rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration.
   */
  skeleton: ReactNode;
  /**
   * Wraps every branch, so whatever chrome the surface needs (a
   * breadcrumb, a scroll container) survives a failed fetch too.
   * Defaults to rendering the branch bare.
   */
  shell?: (children: ReactNode) => ReactNode;
  /**
   * Extra wrapper class for just the two {@link EmptyState} branches.
   * The pages get their padding from `DetailShell`; the panels, which
   * have no shell, need it here.
   */
  emptyClassName?: string;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

export function QueryGate<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  shell,
  emptyClassName,
  children,
}: QueryGateProps<T>) {
  const wrap = shell ?? ((node: ReactNode) => <>{node}</>);
  const empty = (node: ReactNode) =>
    wrap(emptyClassName ? <div className={emptyClassName}>{node}</div> : node);

  if (!isApiConfigured) {
    return empty(
      <EmptyState
        icon={icon}
        title="API not configured"
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
      />,
    );
  }

  if (query.isLoading) {
    return wrap(skeleton);
  }

  // A query can settle without erroring and still hand back nothing (a
  // 404 mapped to undefined). That has to land on the error state, not
  // render the body with a missing row.
  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return empty(
      <EmptyState
        icon={AlertTriangle}
        title={`Couldn't load ${noun}`}
        description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
      />,
    );
  }

  return wrap(children(query.data));
}
