"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

/**
 * Single source for the two load states every data-backed page opens with:
 * "NEXT_PUBLIC_BV_API_URL isn't set" and "the fetch failed".
 *
 * `DetailGate` already did this for the detail pages. The list pages each
 * hand-rolled the same preamble, and the copy had drifted badly: one
 * condition carried nine different titles, the process that serves the URL
 * was variously "the MCP server", "the API server" and "the api server"
 * (one process, three names), and four pages reported a *configuration*
 * problem as an *empty result* — "No promotions yet", "No mesh asks yet",
 * "No facts learned yet", "No tasks yet" — which reads as "you have no
 * data" when the truth is "the app isn't pointed at an API".
 *
 * Both messages are derived from `noun` here, so a page can't word them a
 * tenth way. `DetailGate` builds its own strings from the same helpers.
 */

/** The one name for the process that serves `NEXT_PUBLIC_BV_API_URL`. */
const SERVER_NAME = "API server";

export const API_NOT_CONFIGURED_TITLE = "API not configured";

/** `noun` slots into "to load …" — "runtimes", "mesh activity", "this task". */
export function apiNotConfiguredDescription(noun: string): string {
  return `Set NEXT_PUBLIC_BV_API_URL and run the ${SERVER_NAME} to load ${noun}.`;
}

/** `noun` slots into "Couldn't load …" — same word the description uses. */
export function loadFailedTitle(noun: string): string {
  return `Couldn't load ${noun}`;
}

export const LOAD_FAILED_DESCRIPTION = `Check that the ${SERVER_NAME} is reachable.`;

/**
 * The dashed-border box the list pages put a gate state in, so an empty
 * page still reads as a container rather than floating text.
 */
export function GatePanel({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border">{children}</div>;
}

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase subject of both messages — "runtimes", "mesh activity". */
  noun: string;
  /** The react-query result driving the page. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder, rendered bare (no panel). Per-page rather than
   * generic: the skeleton mirrors the layout it stands in for, so a shared
   * one would jump on hydration.
   */
  skeleton: ReactNode;
  /** Overrides {@link LOAD_FAILED_DESCRIPTION} — runtimes passes `describeError(err)`. */
  errorDescription?: string;
  /** True when the fetch succeeded but there is nothing to render. */
  isEmpty?: (data: T) => boolean;
  /** Rendered in place of `children` when `isEmpty` says so. */
  empty?: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The preamble every list page opens with: API not configured, failed to
 * load, still loading, loaded-but-empty, then the body.
 *
 * Unlike `DetailGate` this renders no shell — list pages own wildly
 * different page chrome (a 5-column mesh grid, a 3-column KPI row, a
 * single-column runtime stack), and folding that in would have meant a
 * shell prop per page.
 */
export function ListGate<T>({
  icon,
  noun,
  query,
  skeleton,
  errorDescription,
  isEmpty,
  empty,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return (
      <GatePanel>
        <EmptyState
          icon={icon}
          title={API_NOT_CONFIGURED_TITLE}
          description={apiNotConfiguredDescription(noun)}
        />
      </GatePanel>
    );
  }

  if (query.isError) {
    return (
      <GatePanel>
        <EmptyState
          icon={AlertTriangle}
          title={loadFailedTitle(noun)}
          description={errorDescription ?? LOAD_FAILED_DESCRIPTION}
        />
      </GatePanel>
    );
  }

  // A settled query with no data means the fetch hasn't produced anything
  // yet (disabled, or mid-hydration). Holding the skeleton is honest; the
  // pages that used to `return null` here just flashed blank instead.
  if (query.isLoading || query.data === undefined) {
    return <>{skeleton}</>;
  }

  if (empty && isEmpty?.(query.data)) {
    return <>{empty}</>;
  }

  return <>{children(query.data)}</>;
}
