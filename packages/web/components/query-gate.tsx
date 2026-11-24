"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { describeError } from "@/lib/api/http";
import { EmptyState } from "@/components/empty-state";

/** Copy for the "fetch succeeded but there's nothing to show" branch. */
export interface EmptyCopy {
  icon?: LucideIcon;
  title: string;
  description?: string;
  cta?: { href: string; label: string };
}

interface Props<T> {
  /**
   * Icon for the unconfigured branch (and the default for `empty`). The
   * error branch is always AlertTriangle, as in `DetailGate`.
   */
  icon?: LucideIcon;
  /**
   * Lowercase plural of what the page lists — "agents", "promotion events".
   * Both the unconfigured and the error message are derived from it, so a
   * page cannot word either one its own way.
   */
  noun: string;
  /**
   * Title for the unconfigured branch. Defaults to "API not configured";
   * pages that would rather lead with the empty-ish framing they already
   * shipped ("No promotions yet") pass their own.
   */
  unconfiguredTitle?: string;
  /**
   * The react-query result driving the page. When it carries an `error`,
   * that is what the failure branch shows; react-query reports `null`
   * rather than `undefined` on the success path, so this tests for
   * truthiness, not for the key's presence.
   */
  query: { data: T | undefined; isLoading: boolean; isError: boolean; error?: unknown };
  /**
   * Loading placeholder. Per-page rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /**
   * Shown when the fetch settled with nothing to list. Omit on pages whose
   * content component renders its own zero-row state.
   */
  empty?: EmptyCopy;
  /**
   * Whether loaded data counts as empty. Defaults to "an empty array" —
   * pages whose payload is a single object (a dashboard rollup) have no
   * empty branch and leave both this and `empty` unset.
   */
  isEmpty?: (data: T) => boolean;
  /**
   * Wraps each non-content branch. Defaults to the dashed-border card the
   * list pages had each spelled out inline; pages that centre the card, or
   * put it in a table cell, pass their own.
   */
  frame?: (node: ReactNode) => ReactNode;
  children: (data: T) => ReactNode;
}

function defaultFrame(node: ReactNode): ReactNode {
  return <div className="rounded-lg border border-dashed border-border">{node}</div>;
}

/**
 * The four-branch preamble every list / overview page opens with — API not
 * configured, still loading, failed to load, loaded but empty — and the
 * sibling of `DetailGate`, which does the same job for detail pages.
 *
 * `DetailGate` exists because that copy had drifted across the detail
 * pages; it drifted the same way on the list side, which kept its gates
 * hand-written. One process was called "the MCP server" on six pages, "the
 * api server" on two and "the API server" on one, and the fetch-failure
 * branch variously said "is running", "is reachable", "logs" or nothing at
 * all. Deriving both messages from `noun` here is what stops a tenth
 * wording appearing with the next page.
 *
 * Branch order matches `DetailGate`: an unconfigured API is reported ahead
 * of a failed fetch (with no base URL the request cannot have been made,
 * so "couldn't load" would be misleading), and a settled-but-dataless
 * query lands on the error branch rather than rendering content with
 * nothing in hand.
 */
export function QueryGate<T>({
  icon,
  noun,
  unconfiguredTitle,
  query,
  skeleton,
  empty,
  isEmpty,
  frame = defaultFrame,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return frame(
      <EmptyState
        icon={icon}
        title={unconfiguredTitle ?? "API not configured"}
        description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${noun}.`}
      />,
    );
  }

  if (query.isLoading) return skeleton;

  if (query.isError || !query.data) {
    return frame(
      <EmptyState
        icon={AlertTriangle}
        title={`Couldn't load ${noun}`}
        description={
          query.error
            ? describeError(query.error)
            : "Check that the API server is reachable."
        }
      />,
    );
  }

  const blank = isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0;
  if (blank && empty) {
    return frame(
      <EmptyState
        icon={empty.icon ?? icon}
        title={empty.title}
        description={empty.description}
        cta={empty.cta}
      />,
    );
  }

  return <>{children(query.data)}</>;
}
