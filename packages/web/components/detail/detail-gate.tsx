"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DetailShell } from "./detail-shell";
import { QueryGate, type GateQuery } from "./query-gate";

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
  query: GateQuery<T>;
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /** Rendered inside the shell once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * A detail route's {@link QueryGate}: the same three-branch preamble, inside
 * the `DetailShell` all four states share, with the page's id echoed back in
 * the fetch-error message so a failed load is identifiable.
 *
 * The shell wraps every branch — including the skeleton and the loaded body —
 * which is why it sits outside the gate rather than being one of the gate's
 * frames, and why the gate is told `frame="none"`.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <DetailShell nav={nav}>
      <QueryGate
        icon={icon}
        noun={noun}
        subject={`this ${noun}`}
        errorDetail={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        frame="none"
        query={query}
        skeleton={skeleton}
      >
        {children}
      </QueryGate>
    </DetailShell>
  );
}
