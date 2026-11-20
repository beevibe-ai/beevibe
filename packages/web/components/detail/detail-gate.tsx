"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";
import { gateState, type QueryLike } from "./query-gate";

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
  query: QueryLike<T>;
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /** Rendered inside the shell once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The four-branch preamble every detail page opens with — API not
 * configured, still loading, failed to load, ready — plus the
 * `DetailShell` all four states share.
 *
 * Written out by hand on each page before this existed, which is why the
 * copy had drifted: the same condition variously said "run the API server",
 * "run the api server" and "run the MCP server" (one process, three names),
 * and half the pages ended the fetch error with "Check the MCP server logs"
 * while the other half dropped the hint.
 *
 * The branch order and both messages now come from `gateState`, which the
 * peek panels share — see `query-gate.ts` for why that split exists.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  const state = gateState(noun, id, query);
  const shell = (body: ReactNode) => <DetailShell nav={nav}>{body}</DetailShell>;

  switch (state.kind) {
    case "unconfigured":
      return shell(
        <EmptyState icon={icon} title={state.title} description={state.description} />,
      );
    case "loading":
      return shell(skeleton);
    case "error":
      return shell(
        <EmptyState
          icon={AlertTriangle}
          title={state.title}
          description={state.description}
        />,
      );
    case "ready":
      return shell(children(state.data));
  }
}
