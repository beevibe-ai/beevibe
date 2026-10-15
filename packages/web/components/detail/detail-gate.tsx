"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";
import { type DetailQuery, resolveDetailState } from "./detail-state";

interface Props<T> {
  /**
   * Breadcrumb or back-link, rendered above the body in every state so the
   * user can navigate away from a page that failed to load. Pages whose
   * breadcrumb needs the fetched row pass `data ? <Crumbs row={data}/> : undefined`.
   */
  nav?: ReactNode;
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the page shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the page. */
  query: DetailQuery<T>;
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /** Rendered inside the shell once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every detail *page* opens with — API not
 * configured, still loading, failed to load — plus the `DetailShell` all
 * four states share.
 *
 * The branch order and the copy come from {@link resolveDetailState}; this
 * component is just the page chrome around them. The peek-panel surfaces use
 * the same resolver through `PanelGate`, which differs only in wrapper.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  const state = resolveDetailState(noun, id, query);

  if (state.kind === "loading") {
    return <DetailShell nav={nav}>{skeleton}</DetailShell>;
  }

  if (state.kind === "ready") {
    return <DetailShell nav={nav}>{children(state.data)}</DetailShell>;
  }

  return (
    <DetailShell nav={nav}>
      <EmptyState
        icon={state.kind === "unconfigured" ? icon : AlertTriangle}
        title={state.title}
        description={state.description}
      />
    </DetailShell>
  );
}
