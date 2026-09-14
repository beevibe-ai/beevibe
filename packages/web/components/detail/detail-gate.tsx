"use client";

import type { ReactNode } from "react";
import { DetailShell } from "./detail-shell";
import { QueryGate, type QueryGateProps } from "./query-gate";

interface Props<T> extends Omit<QueryGateProps<T>, "stateClassName"> {
  /**
   * Breadcrumb or back-link, rendered above the body in every state so the
   * user can navigate away from a page that failed to load. Pages whose
   * breadcrumb needs the fetched row pass `data ? <Crumbs row={data}/> : undefined`.
   */
  nav?: ReactNode;
}

/**
 * {@link QueryGate} wrapped in the `DetailShell` the full-page detail
 * routes share. The branch logic itself lives in `QueryGate`, because the
 * agent and task peek panels need the same three states without a page
 * shell around them.
 *
 * The nav sits outside the gate rather than inside each branch: it is what
 * gets the user off a page that failed to load, so it has to survive every
 * state, not just the happy one.
 */
export function DetailGate<T>({ nav, ...gate }: Props<T>) {
  return (
    <DetailShell nav={nav}>
      <QueryGate {...gate} />
    </DetailShell>
  );
}
