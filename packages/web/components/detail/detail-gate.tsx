"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DetailShell } from "./detail-shell";
import { DetailStateMessage, detailState, type DetailQuery } from "./detail-state";

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
 * The three-branch preamble every detail page opens with — API not
 * configured, still loading, failed to load — plus the `DetailShell` all
 * four states share.
 *
 * Written out by hand on each page before this existed, which is why the
 * copy had drifted: the same condition variously said "run the API server",
 * "run the api server" and "run the MCP server" (one process, three names),
 * and half the pages ended the fetch error with "Check the MCP server logs"
 * while the other half dropped the hint.
 *
 * The branch logic and both messages now live in `detailState`, one level
 * down, so the surfaces that can't take the `DetailShell` wrapper — the
 * agent and task peek panels, the room view — share them too instead of
 * wording them a fourth way. This component is the `DetailShell` binding
 * of it, which is all the full-page routes need.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  const state = detailState({ noun, id, icon, query });

  return (
    <DetailShell nav={nav}>
      {state.kind === "ready" ? (
        children(state.data)
      ) : state.kind === "loading" ? (
        skeleton
      ) : (
        <DetailStateMessage state={state} />
      )}
    </DetailShell>
  );
}
