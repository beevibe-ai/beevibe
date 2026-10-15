"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { type DetailQuery, resolveDetailState } from "./detail-state";

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "agent", "task", "room". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the surface. */
  query: DetailQuery<T>;
  /**
   * Loading placeholder, including its own padding. Per-surface rather than
   * generic: the skeleton mirrors the layout it stands in for, so a shared
   * one would jump on hydration.
   */
  skeleton: ReactNode;
  /**
   * Wrapper classes for the two `EmptyState` branches. Defaults to the peek
   * panels' `p-4`; the full-width room view centers instead. The loaded body
   * and the skeleton bring their own padding, so this is the only knob.
   */
  emptyClassName?: string;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * {@link resolveDetailState} rendered for a surface that supplies its own
 * outer chrome — the agent and task peek panels (already inside a
 * `PeekPanel`) and the room view (already inside the chat column).
 *
 * Separate from `DetailGate` only because that one wraps every state in
 * `DetailShell`, which a surface that is already positioned must not get. The
 * branch order and the copy are shared, which is the part that had drifted:
 * each of these three surfaces had hand-written the gate, and all three had
 * ended up saying something different about an unconfigured API.
 */
export function PanelGate<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  emptyClassName = "p-4",
  children,
}: Props<T>) {
  const state = resolveDetailState(noun, id, query);

  if (state.kind === "loading") return <>{skeleton}</>;
  if (state.kind === "ready") return <>{children(state.data)}</>;

  return (
    <div className={emptyClassName}>
      <EmptyState
        icon={state.kind === "unconfigured" ? icon : AlertTriangle}
        title={state.title}
        description={state.description}
      />
    </div>
  );
}
