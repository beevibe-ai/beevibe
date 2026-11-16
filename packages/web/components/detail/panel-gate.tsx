"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { gateBranch, type GateQuery } from "./gate-branch";

/**
 * `DetailGate`'s triage for a peek panel instead of a full page.
 *
 * The agent peek and the task peek each had this written out inline —
 * the same three branches in the same order, with the same two
 * `EmptyState`s — because `DetailGate` bundles its branches with
 * `DetailShell`, which a panel body does not want (the `PeekPanel`
 * shell is already around it). Splitting the branches out into
 * `./gate-branch` lets both shells reuse them, so the panels stop being
 * the two surfaces whose "API not configured" copy was a sentence short.
 *
 * Padding is the only thing this adds: `p-5 space-y-4` around a
 * skeleton, which stands in for the real body's layout, and `p-4`
 * around an `EmptyState`.
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
  query: GateQuery<T>;
  /** Loading placeholder, mirroring this panel's own layout. */
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const branch = gateBranch({ icon, noun, id, query, skeleton });
  if (branch.ready) return <>{children(branch.data)}</>;
  if (branch.kind === "loading") {
    return <div className="p-5 space-y-4">{branch.node}</div>;
  }
  return <div className="p-4">{branch.node}</div>;
}
