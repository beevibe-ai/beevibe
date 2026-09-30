"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { describeError } from "@/lib/api/http";
import { EmptyState } from "@/components/empty-state";

/**
 * An `EmptyState` in the dashed-border card the list pages frame it
 * with. Eight files had written the wrapper `div` out by hand and
 * `promotions-client` had already extracted a private `EmptyWrapper`
 * for it locally.
 */
export function EmptyPanel({
  icon,
  title,
  description,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Extra classes on the card, e.g. a width cap. */
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-dashed border-border${className ? ` ${className}` : ""}`}
    >
      <EmptyState icon={icon} title={title} description={description} />
    </div>
  );
}

interface Props<T> {
  /**
   * Icon for the "API not configured" state — usually the same glyph
   * the page uses in its nav. The error state is always AlertTriangle.
   */
  icon?: LucideIcon;
  /**
   * What the page lists, lowercase, as it reads inside "…to load X" and
   * "Couldn't load X" — "mesh activity", "promotions", "runtimes".
   */
  noun: string;
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean; error?: unknown };
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration. Also stands in for the unreachable `!data` case below.
   */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every list / overview page opens with — API
 * not configured, failed to load, still loading.
 *
 * `DetailGate` has done this for the detail pages since it landed; the
 * list pages kept hand-rolling it, and drifted the same way the detail
 * pages had before. Two kinds of drift, both fixed by routing the copy
 * through `noun`:
 *
 *  - The unconfigured branch was mislabelled as an empty one. `/mesh`
 *    answered a missing `NEXT_PUBLIC_BV_API_URL` with "No mesh asks
 *    yet" and `/promotions` with "No promotions yet" — telling the user
 *    their fleet had done nothing when in fact the page had never asked.
 *  - The process got three names across five pages: "run the API
 *    server", "run the MCP server", "Check that the MCP server is
 *    reachable". It is one process, and `DetailGate` already calls it
 *    the API server.
 *
 * The error description comes from `describeError(query.error)` when
 * the page passes `error` through, which is strictly more useful than
 * a fixed hint — react-query surfaces the server's own message there.
 *
 * This gate deliberately does NOT own the "loaded, but empty" state:
 * what counts as empty differs per page (a zero-length array, a bag of
 * arrays that are each empty) and the copy is page-specific, so that
 * stays in `children`.
 */
export function ListGate<T>({ icon, noun, query, skeleton, children }: Props<T>) {
  if (!isApiConfigured) {
    return (
      <EmptyPanel
        icon={icon}
        title="API not configured"
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${noun}.`}
      />
    );
  }

  if (query.isError) {
    return (
      <EmptyPanel
        icon={AlertTriangle}
        title={`Couldn't load ${noun}`}
        description={
          query.error === undefined
            ? "Check that the API server is reachable."
            : describeError(query.error)
        }
      />
    );
  }

  // `!data` is unreachable in practice — the query is `enabled:
  // isApiConfigured`, which the first branch already returned for — but
  // it narrows `T | undefined` for `children` and the skeleton is the
  // honest thing to show if it ever happens.
  if (query.isLoading || !query.data) return <>{skeleton}</>;

  return <>{children(query.data)}</>;
}
