"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";

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
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
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
 * while the other half dropped the hint. Both messages are derived from
 * `noun` here, so a page can't word them a fourth way.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  if (!isApiConfigured) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
        />
      </DetailShell>
    );
  }

  if (query.isLoading) {
    return <DetailShell nav={nav}>{skeleton}</DetailShell>;
  }

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        />
      </DetailShell>
    );
  }

  return <DetailShell nav={nav}>{children(query.data)}</DetailShell>;
}
