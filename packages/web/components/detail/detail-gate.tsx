"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";

/** Which branch of the gate is rendering. See `shell`. */
export type GateBranch = "unconfigured" | "loading" | "error" | "ready";

interface Props<T> {
  /**
   * Breadcrumb or back-link, rendered above the body in every state so the
   * user can navigate away from a page that failed to load. Pages whose
   * breadcrumb needs the fetched row pass `data ? <Crumbs row={data}/> : undefined`.
   *
   * Ignored when `shell` is given — a caller supplying its own chrome owns
   * where (or whether) a nav goes.
   */
  nav?: ReactNode;
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the page shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /**
   * Chrome around whichever branch renders. Defaults to `DetailShell` — the
   * full-page routes all want the nav and the centered column in every
   * state, including the failures.
   *
   * The peek panels (`AgentDetailPanel`, `TaskDetailPanel`) pass their own:
   * their chrome is `PeekPanel`, a level above, and their loaded body
   * manages its own padding, so they wrap only the two `EmptyState`
   * branches. Hence the `branch` argument — a caller that padded `"ready"`
   * too would double-pad the body it was handed.
   */
  shell?: (content: ReactNode, branch: GateBranch) => ReactNode;
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
 * while the other half dropped the hint. Both messages are derived from
 * `noun` here, so a page can't word them a fourth way.
 */
export function DetailGate<T>({
  nav,
  icon,
  noun,
  id,
  query,
  skeleton,
  shell,
  children,
}: Props<T>) {
  const wrap =
    shell ?? ((content: ReactNode) => <DetailShell nav={nav}>{content}</DetailShell>);

  if (!isApiConfigured) {
    return wrap(
      <EmptyState
        icon={icon}
        title="API not configured"
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
      />,
      "unconfigured",
    );
  }

  if (query.isLoading) {
    return wrap(skeleton, "loading");
  }

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return wrap(
      <EmptyState
        icon={AlertTriangle}
        title={`Couldn't load ${noun}`}
        description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
      />,
      "error",
    );
  }

  return wrap(children(query.data), "ready");
}

/**
 * The `shell` the peek panels pass: no `DetailShell`, because `PeekPanel`
 * is already the chrome a level above, and padding on only the two
 * `EmptyState` branches — the skeleton a panel supplies brings its own,
 * and the loaded body manages its own.
 *
 * Shared so the two panels can't drift from each other the way their
 * hand-written gates did.
 */
export function peekPanelShell(content: ReactNode, branch: GateBranch): ReactNode {
  if (branch === "loading" || branch === "ready") return content;
  return <div className="p-4">{content}</div>;
}
