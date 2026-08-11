"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

/**
 * The dashed-border card every list page frames an {@link EmptyState} in.
 *
 * `EmptyState` itself is just the centered icon/title/description stack —
 * on a list surface it needs a border so it reads as "this panel is empty"
 * rather than as loose body copy. Every page wrote that border by hand;
 * `promotions-client` had already extracted a private `EmptyWrapper` doing
 * exactly this, which is what made it worth hoisting.
 */
export function EmptyCard({
  icon,
  title,
  description,
  cta,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Passed straight through to {@link EmptyState}. */
  cta?: { href: string; label: string };
  /** Extra classes on the card — width caps and backgrounds, mostly. */
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-dashed border-border", className)}>
      <EmptyState icon={icon} title={title} description={description} cta={cta} />
    </div>
  );
}

/** Copy for one of the gate's two failure branches. */
export interface GateMessage {
  icon?: LucideIcon;
  title: string;
  description?: string;
}

interface Props<T> {
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Shown when `NEXT_PUBLIC_BV_API_URL` is unset. Per-page rather than
   * derived: some surfaces frame this as a setup instruction ("API not
   * configured") and others as an empty state ("No promotions yet"),
   * because an unconfigured web app and an idle one look the same to the
   * user standing in front of them.
   */
  notConfigured: GateMessage;
  /** Shown when the fetch failed. `icon` defaults to `AlertTriangle`. */
  error: GateMessage;
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration.
   */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every list/overview page opens with — API not
 * configured, failed to load, still loading — before it has data to render.
 *
 * The sibling of {@link import("./detail/detail-gate").DetailGate}, which
 * does the same job for the `/<thing>/[id]` detail pages. That one was
 * extracted first and the list pages were left hand-rolling the same three
 * branches, so the same copy drift DetailGate exists to prevent had set in
 * again on this side: the not-configured branch variously told the user to
 * "run the API server", "run the api server" and "run the MCP server" for
 * what is one process.
 *
 * The branch *copy* stays per-page (see {@link Props.notConfigured}) — what
 * is unified here is the structure and the branch order, so a page can't
 * grow a fourth ordering or forget a branch outright.
 */
export function PageGate<T>({ query, notConfigured, error, skeleton, children }: Props<T>) {
  if (!isApiConfigured) {
    return <EmptyCard {...notConfigured} />;
  }

  if (query.isError) {
    return <EmptyCard icon={AlertTriangle} {...error} />;
  }

  // `data === undefined` shares the loading branch: it is the pre-first-fetch
  // state, and showing the skeleton for it is what the pages that special-cased
  // it already did.
  if (query.isLoading || query.data === undefined) {
    return <>{skeleton}</>;
  }

  return <>{children(query.data)}</>;
}
