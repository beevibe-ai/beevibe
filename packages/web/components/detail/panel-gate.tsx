"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";
import { gateCopy } from "./gate-copy";

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the panel shows — "agent", "task". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the panel. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder, rendered inside the panel's own padding. Per-panel
   * because it mirrors the layout it stands in for.
   */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. Owns its own padding. */
  children: (data: T) => ReactNode;
}

/**
 * The three-branch preamble both peek panels open with — API not
 * configured, still loading, failed to load.
 *
 * The panel-shaped sibling of {@link import("./detail-gate").DetailGate}:
 * same branches, same order, same copy (both derive it from
 * {@link gateCopy}), rendered into the panel's padding instead of a
 * `DetailShell`. `AgentDetailPanel` and `TaskDetailPanel` each had a
 * byte-identical copy of it down to the class names, which is the same
 * reason `PanelFooterField` lives in `peek-panel.tsx`.
 */
export function PanelGate<T>({ icon, noun, id, query, skeleton, children }: Props<T>) {
  const copy = gateCopy(noun, id);

  if (!isApiConfigured) {
    return (
      <div className="p-4">
        <EmptyState icon={icon} title="API not configured" description={copy.notConfigured} />
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="p-5 space-y-4">{skeleton}</div>;
  }

  if (query.isError || query.data === undefined) {
    return (
      <div className="p-4">
        <EmptyState
          icon={AlertTriangle}
          title={copy.errorTitle}
          description={copy.errorDescription}
        />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}
