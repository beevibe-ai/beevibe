"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { apiNotConfiguredCopy, loadFailedCopy } from "@/lib/empty-copy";
import { EmptyPanel } from "@/components/empty-panel";

interface Props<T> {
  /**
   * Lowercase phrase naming what the page shows — "mesh activity",
   * "promotions", "runtimes". Both messages are derived from it, so a
   * page can't word them its own way.
   */
  noun: string;
  /**
   * Completes "…to load ___" when `noun` alone is ungrammatical there.
   * The error title wants a bare noun ("Couldn't load dashboard") where
   * the sentence wants an article ("…to load the dashboard."). Defaults
   * to `noun`, which is right for the plural and mass nouns.
   */
  target?: string;
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration.
   */
  skeleton: ReactNode;
  /**
   * Replaces the derived error description when the page has something
   * more specific to say — `runtimes` passes `describeError(query.error)`
   * to surface the HTTP status.
   */
  errorDescription?: string;
  /** Rendered once the fetch succeeded. Page-specific "no rows yet" states live here. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every overview page opens with — API not
 * configured, still loading, failed to load.
 *
 * This is {@link import("./detail/detail-gate").DetailGate} for the pages
 * that aren't about a single row. The detail pages got that component and
 * stopped drifting; the overview pages kept hand-rolling the same three
 * branches as a local `Body` helper, and their copy drifted exactly the
 * way `DetailGate`'s doc-comment describes. Unlike `DetailGate` this owns
 * no page chrome: the overview pages' headers and width caps genuinely
 * differ, so each page keeps its own and wraps only the body.
 *
 * `isLoading` is checked before `isError` — with react-query the two are
 * mutually exclusive, so the order the pages used varied; fixing one
 * order keeps a skeleton from flashing under a cached error.
 */
export function PageGate<T>({
  noun,
  target,
  icon,
  query,
  skeleton,
  errorDescription,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return <EmptyPanel icon={icon} {...apiNotConfiguredCopy(target ?? noun)} />;
  }

  if (query.isLoading) return <>{skeleton}</>;

  if (query.isError) {
    const copy = loadFailedCopy(noun);
    return (
      <EmptyPanel
        icon={AlertTriangle}
        title={copy.title}
        description={errorDescription ?? copy.description}
      />
    );
  }

  // A settled, non-error query with no data is transient (a cache seed, a
  // cancelled refetch). Hold the skeleton rather than flashing an error.
  if (!query.data) return <>{skeleton}</>;

  return <>{children(query.data)}</>;
}
