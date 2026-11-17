"use client";

import type { ReactNode } from "react";
import { DetailShell } from "./detail-shell";
import { QueryGate, type QueryGateProps } from "./query-gate";

/**
 * {@link QueryGate} wrapped in the `DetailShell` all four of its states
 * share — the standard opening for a full-page detail route.
 *
 * The gate's own branches live in `query-gate.tsx` because the peek panels
 * need the same three states without a page shell around them.
 */
export function DetailGate<T>({
  nav,
  ...gate
}: QueryGateProps<T> & {
  /**
   * Breadcrumb or back-link, rendered above the body in every state so the
   * user can navigate away from a page that failed to load. Pages whose
   * breadcrumb needs the fetched row pass `data ? <Crumbs row={data}/> : undefined`.
   */
  nav?: ReactNode;
}) {
  return (
    <DetailShell nav={nav}>
      <QueryGate {...gate} />
    </DetailShell>
  );
}
