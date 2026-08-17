"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import {
  apiNotConfiguredState,
  fetchFailedTitle,
  FETCH_FAILED_HINT,
} from "@/lib/api-state-copy";

interface Props<T> {
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Lowercase noun phrase for what the page lists, read after "to load" and
   * after "Couldn't load" — "mesh activity", "promotion events", "runtimes".
   */
  noun: string;
  /** Icon for the not-configured and empty states. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   * Rendered bare — `wrapper` applies only to the three EmptyState branches.
   */
  skeleton: ReactNode;
  /**
   * Copy for "the fetch succeeded and there is nothing in it". Omit to render
   * nothing in that case (a page whose content component draws its own empty
   * state).
   */
  empty?: { title: string; description?: string };
  /**
   * Whether loaded data counts as empty. Defaults to "an array with no
   * elements" — pages whose payload wraps the list (`{ asks }`, `{ daemons }`)
   * pass their own predicate.
   */
  isEmpty?: (data: T) => boolean;
  /** Overrides {@link FETCH_FAILED_HINT} when the page can say something sharper. */
  errorDescription?: string;
  /**
   * Container for the three placeholder states. Defaults to the dashed-border
   * box the list pages already share; pages that place their states somewhere
   * structurally different (a table row, a centered overlay) pass their own.
   */
  wrapper?: (node: ReactNode) => ReactNode;
  /** Rendered once the fetch succeeded and produced something to show. */
  children: (data: T) => ReactNode;
}

function defaultWrapper(node: ReactNode): ReactNode {
  return <div className="rounded-lg border border-dashed border-border">{node}</div>;
}

function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

/**
 * The load-state ladder every list page opens with — API not configured,
 * still loading, fetch failed, nothing to show — and the shared copy for the
 * first and third of those.
 *
 * This is the list-side counterpart to `DetailGate`. That component fixed the
 * same duplication for detail pages; the eight list pages kept hand-rolling
 * the ladder, and their copy drifted exactly the way the detail pages' had
 * (see `lib/api-state-copy.ts` for the catalogue). Both gates now derive
 * their wording from the same two helpers, so a page cannot invent a fourth
 * name for the api server.
 *
 * Branch order matches `DetailGate`: not-configured before loading before
 * error. Several list pages had checked error before loading; with
 * react-query those two are never simultaneously true, so the order is a
 * consistency choice rather than a behavior change.
 */
export function ListGate<T>({
  query,
  noun,
  icon,
  skeleton,
  empty,
  isEmpty = defaultIsEmpty,
  errorDescription,
  wrapper = defaultWrapper,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    const copy = apiNotConfiguredState(noun);
    return wrapper(
      <EmptyState icon={icon} title={copy.title} description={copy.description} />,
    );
  }

  if (query.isLoading) return skeleton;

  if (query.isError) {
    return wrapper(
      <EmptyState
        icon={AlertTriangle}
        title={fetchFailedTitle(noun)}
        description={errorDescription ?? FETCH_FAILED_HINT}
      />,
    );
  }

  // A query can settle without erroring and still hand back nothing. Treat
  // that as empty rather than handing `undefined` to the content component.
  if (!query.data || isEmpty(query.data)) {
    if (!empty) return null;
    return wrapper(
      <EmptyState icon={icon} title={empty.title} description={empty.description} />,
    );
  }

  return children(query.data);
}
