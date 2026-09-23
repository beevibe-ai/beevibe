"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

export interface GateQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Chrome around the two empty states. The body and the skeleton are never
 * framed — a page owns its own loaded layout.
 *
 * - `dashed` — the dashed-border card the list pages put an empty state in.
 * - `pad` — the bare padding the peek panels use inside their own shell.
 * - `none` — nothing, for callers whose shell already wraps every branch
 *   (`DetailGate` renders inside `DetailShell`).
 */
export type GateFrame = "dashed" | "pad" | "none";

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /**
   * Lowercase noun for what the surface shows — "dashboard", "mesh
   * activity", "runtimes". The fetch-error title reads `Couldn't load
   * ${noun}`, which is what every call site already said by hand.
   */
  noun: string;
  /**
   * Noun phrase in the not-configured description, when it differs from
   * `noun`. Detail surfaces pass `this task` so the sentence reads "to load
   * this task" rather than "to load task".
   */
  subject?: string;
  /**
   * Title of the not-configured state. Defaults to "API not configured";
   * override where the page has its own product copy for it.
   */
  notConfiguredTitle?: string;
  /**
   * Second line of the fetch-error state. Omit for a bare title — several
   * pages deliberately show none.
   */
  errorDetail?: string;
  frame?: GateFrame;
  /** The react-query result driving the surface. */
  query: GateQuery<T>;
  /**
   * Loading placeholder. Per-surface rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration.
   */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every data-backed surface opens with — API not
 * configured, still loading, failed to load.
 *
 * Written out by hand on each surface before this existed, in three shapes
 * that were the same logic wearing different chrome: the list pages
 * (`dashboard`, `mesh`, `promotions`, `runtimes`) each had a local `Body`
 * that put its empty states in a dashed-border card, the peek panels
 * (`AgentDetailPanel`, `TaskDetailPanel`) each had a local `PanelBody` that
 * padded them instead, and the detail routes had {@link DetailGate}, which
 * now delegates here.
 *
 * Copy is derived from `noun` rather than spelled out per call site, because
 * the hand-written copies had drifted: seven surfaces told the user to "run
 * the MCP server", one "run the api server" and one "run the API server" —
 * one process, three names. `DetailGate` already fixed that for the detail
 * routes; this carries the same fix to the rest.
 *
 * Branch order is `DetailGate`'s and matters in two places. An unconfigured
 * API is reported ahead of a failed fetch, so a page that never had a URL to
 * call doesn't accuse the server of being down. And a query that settled
 * without erroring but handed back nothing (a 404 mapped to `undefined`)
 * lands on the error state rather than rendering the body with a missing
 * row.
 */
export function QueryGate<T>({
  icon,
  noun,
  subject,
  notConfiguredTitle = "API not configured",
  errorDetail,
  frame = "dashed",
  query,
  skeleton,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return (
      <GateFrameBox frame={frame}>
        <EmptyState
          icon={icon}
          title={notConfiguredTitle}
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${subject ?? noun}.`}
        />
      </GateFrameBox>
    );
  }

  if (query.isLoading) {
    return <>{skeleton}</>;
  }

  if (query.isError || !query.data) {
    return (
      <GateFrameBox frame={frame}>
        <EmptyState icon={AlertTriangle} title={`Couldn't load ${noun}`} description={errorDetail} />
      </GateFrameBox>
    );
  }

  return <>{children(query.data)}</>;
}

function GateFrameBox({ frame, children }: { frame: GateFrame; children: ReactNode }) {
  if (frame === "none") return <>{children}</>;
  return (
    <div className={frame === "dashed" ? "rounded-lg border border-dashed border-border" : "p-4"}>
      {children}
    </div>
  );
}
