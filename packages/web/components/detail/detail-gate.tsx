"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";
import { fetchErrorCopy, notConfiguredCopy } from "@/components/api-state";

/** The react-query result shape the gate reads. */
export interface GateQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Which of the four states an API-backed surface is in, with the copy for
 * the two that carry a message already resolved.
 */
export type GateState<T> =
  | { kind: "not_configured"; title: string; description: string }
  | { kind: "loading" }
  | { kind: "error"; title: string; description: string | undefined }
  | { kind: "ready"; data: T };

/**
 * Resolve the state ladder every API-backed surface walks: API not
 * configured, still loading, failed to load, ready.
 *
 * Two things this pins down that hand-rolled ladders kept getting wrong.
 * The unconfigured check comes *first* — a build with no API URL always
 * has a failing query behind it, and reporting that as a fetch error
 * points the reader at the server instead of at their `.env.local`. And
 * a query that settles without erroring can still hand back nothing (a
 * 404 mapped to `undefined`), which has to land on `error`, never on
 * `ready` with a missing row.
 *
 * Split out from `DetailGate` because the peek panels need the same
 * ladder under a different shell: they pad each state differently and
 * sit inside `PeekPanel`, so they can't take `DetailShell` with it. They
 * previously re-derived the whole ladder, and the copy had drifted —
 * their fetch error dropped the "Check the API server logs" hint and
 * their unconfigured message dropped "and run the API server".
 */
export function resolveGateState<T>(noun: string, id: string, query: GateQuery<T>): GateState<T> {
  if (!isApiConfigured) {
    return { kind: "not_configured", ...notConfiguredCopy(`this ${noun}`) };
  }
  if (query.isLoading) return { kind: "loading" };
  if (query.isError || !query.data) {
    return { kind: "error", ...fetchErrorCopy(noun, id) };
  }
  return { kind: "ready", data: query.data };
}

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
 * `resolveGateState` rendered into the `DetailShell` that full-page detail
 * routes share. The peek panels walk the same ladder against their own
 * layout; see `resolveGateState`.
 */
export function DetailGate<T>({ nav, icon, noun, id, query, skeleton, children }: Props<T>) {
  const state = resolveGateState(noun, id, query);

  return (
    <DetailShell nav={nav}>
      {state.kind === "loading" ? (
        skeleton
      ) : state.kind === "ready" ? (
        children(state.data)
      ) : (
        <EmptyState
          icon={state.kind === "not_configured" ? icon : AlertTriangle}
          title={state.title}
          description={state.description}
        />
      )}
    </DetailShell>
  );
}
