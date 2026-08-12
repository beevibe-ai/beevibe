"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon: LucideIcon;
  /** Lowercase singular of what the panel shows — "task", "agent". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the panel. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder, rendered inside the padded stack. Per-panel rather
   * than generic: the skeleton mirrors the layout it stands in for, so a
   * shared one would jump on hydration.
   */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * {@link DetailGate}, for peek panels.
 *
 * The task and agent panels each opened with the same three-branch preamble
 * as the full pages — API not configured, still loading, failed to load —
 * but written out by hand a second time because the panels wrap their states
 * in a padded `div` rather than a `DetailShell`. Two copies of a gate whose
 * whole job is to stop the failure copy from drifting is one copy too many:
 * both messages are derived from `noun` here.
 *
 * Deliberately not folded into `DetailGate` itself. The wrapper is the only
 * thing that differs, but it is what makes the two usable in different
 * places, and threading it through as a prop would leave a component that is
 * a shell factory rather than a gate.
 */
export function PanelGate<T>({ icon, noun, id, query, skeleton, children }: Props<T>) {
  if (!isApiConfigured) {
    return (
      <div className="p-4">
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL to load this ${noun}.`}
        />
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="p-5 space-y-4">{skeleton}</div>;
  }

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return (
      <div className="p-4">
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched.`}
        />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}
