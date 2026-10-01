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
 * The `EmptyState` a detail surface shows when it has nothing to render —
 * either the API isn't configured or the fetch failed.
 *
 * Split out of `DetailGate` so surfaces that can't use the gate still read
 * the same prose. The two detail peek panels and the room page each run the
 * same three branches as a page, but inside their own padding wrapper
 * rather than a `DetailShell`, so they couldn't call `DetailGate` — and all
 * three had drifted exactly the way the gate's own copy once had. The
 * panels dropped "Check the API server logs." from the fetch error and
 * shortened the unconfigured hint; the room page shipped "API not
 * configured" with no description at all. Deriving both messages from
 * `noun` leaves nowhere to word them a fourth way.
 */
export function DetailFallback({
  state,
  noun,
  id,
  icon,
}: {
  state: "unconfigured" | "error";
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Echoed back in the error message so a failed fetch is identifiable. */
  id?: string;
  /** Icon for the unconfigured state; the error state is always AlertTriangle. */
  icon?: LucideIcon;
}) {
  if (state === "unconfigured") {
    return (
      <EmptyState
        icon={icon}
        title="API not configured"
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
      />
    );
  }
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <EmptyState
      icon={AlertTriangle}
      title={`Couldn't load ${noun}`}
      description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
    />
  );
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
 * while the other half dropped the hint. Both messages come from
 * `DetailFallback` here, so a page can't word them a fourth way.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  if (!isApiConfigured) {
    return (
      <DetailShell nav={nav}>
        <DetailFallback state="unconfigured" noun={noun} icon={icon} />
      </DetailShell>
    );
  }

  if (query.isLoading) {
    return <DetailShell nav={nav}>{skeleton}</DetailShell>;
  }

  if (query.isError || !query.data) {
    return (
      <DetailShell nav={nav}>
        <DetailFallback state="error" noun={noun} id={id} />
      </DetailShell>
    );
  }

  return <DetailShell nav={nav}>{children(query.data)}</DetailShell>;
}
