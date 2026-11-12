"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

export interface DetailQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the surface. */
  query: DetailQuery<T>;
  /**
   * Loading placeholder. Per-surface rather than generic: the skeleton
   * mirrors the layout it stands in for, so a shared one would jump on
   * hydration.
   */
  skeleton: ReactNode;
  /**
   * Padding wrapper for the two `EmptyState` branches. A page inherits its
   * padding from `DetailShell` and leaves this unset; the peek panels own
   * their own padding and pass `"p-4"`.
   */
  messageClassName?: string;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble every detail surface opens with — API not
 * configured, still loading, failed to load — and nothing else. No outer
 * chrome, so it serves both the full-page detail routes (via
 * {@link DetailGate}, which adds `DetailShell`) and the peek panels (which
 * are already inside `PeekPanel`).
 *
 * Written out by hand on each surface before this existed, which is why the
 * copy had drifted: the same condition variously said "run the API server",
 * "run the api server" and "run the MCP server" (one process, three names),
 * and half the surfaces ended the fetch error with "Check the MCP server
 * logs" while the other half dropped the hint. Both messages are derived
 * from `noun` here, so a caller can't word them a fourth way.
 */
export function DetailStates<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  messageClassName,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return (
      <Message className={messageClassName}>
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
        />
      </Message>
    );
  }

  if (query.isLoading) return <>{skeleton}</>;

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return (
      <Message className={messageClassName}>
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        />
      </Message>
    );
  }

  return <>{children(query.data)}</>;
}

/** Applies `messageClassName` when the caller supplied one, else renders bare. */
function Message({ className, children }: { className?: string; children: ReactNode }) {
  return className ? <div className={className}>{children}</div> : <>{children}</>;
}
