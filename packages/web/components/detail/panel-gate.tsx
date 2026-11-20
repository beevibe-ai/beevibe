"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { gateState, type QueryLike } from "./query-gate";

/**
 * `DetailGate` for the Notion-style peek panels.
 *
 * Same four branches in the same order, same copy — see `query-gate.ts` —
 * but the chrome is the panel's own padding rather than a `DetailShell`:
 * an empty state sits in `p-4`, the skeleton in `p-5 space-y-4`, and the
 * loaded body brings its own padding because it owns the panel's header
 * and footer layout.
 */
export function PanelGate<T>({
  icon,
  noun,
  id,
  query,
  skeleton,
  children,
}: {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the panel shows — "agent", "task". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  query: QueryLike<T>;
  /** Per-panel placeholder — it mirrors the layout it stands in for. */
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const state = gateState(noun, id, query);

  switch (state.kind) {
    case "unconfigured":
      return (
        <div className="p-4">
          <EmptyState icon={icon} title={state.title} description={state.description} />
        </div>
      );
    case "loading":
      return <div className="p-5 space-y-4">{skeleton}</div>;
    case "error":
      return (
        <div className="p-4">
          <EmptyState
            icon={AlertTriangle}
            title={state.title}
            description={state.description}
          />
        </div>
      );
    case "ready":
      return <>{children(state.data)}</>;
  }
}
