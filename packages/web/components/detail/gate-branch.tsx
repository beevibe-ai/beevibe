import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

export interface GateQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

export type GateBranch<T> =
  | { ready: true; data: T }
  /**
   * `loading` is separated from the two message states because callers
   * pad them differently — a skeleton stands in for the real layout and
   * wants that layout's padding, an `EmptyState` wants its own.
   */
  | { ready: false; kind: "loading" | "message"; node: ReactNode };

/**
 * The three-branch preamble in front of every fetched detail surface —
 * API not configured, still loading, failed to load — resolved once,
 * without deciding what wraps it.
 *
 * `DetailGate` wraps the result in `DetailShell` for a full page;
 * `PanelGate` wraps it in the peek panel's padding. Both read the branch
 * order and the two messages from here, so the copy can't drift the way
 * it had before — the peek panels said "Set NEXT_PUBLIC_BV_API_URL to
 * load this agent." while every page said "...and run the API server to
 * load this agent.", for the same condition.
 *
 * Branch order is load-bearing: an unconfigured API is reported before a
 * failed fetch, because with no API URL the fetch was never going to
 * succeed and "couldn't load" would send the reader after the wrong
 * problem.
 */
export function gateBranch<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
}: {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  query: GateQuery<T>;
  skeleton: ReactNode;
}): GateBranch<T> {
  if (!isApiConfigured) {
    return {
      ready: false,
      kind: "message",
      node: (
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
        />
      ),
    };
  }

  if (query.isLoading) {
    return { ready: false, kind: "loading", node: skeleton };
  }

  // A query can settle without erroring and still hand back nothing (a
  // 404 mapped to undefined); that has to land here, not render a body
  // with a missing row.
  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      ready: false,
      kind: "message",
      node: (
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        />
      ),
    };
  }

  return { ready: true, data: query.data };
}
