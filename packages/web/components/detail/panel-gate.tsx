"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { QueryGate, type GateQuery } from "./query-gate";

interface Props<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the panel shows — "agent", "task". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the panel. */
  query: GateQuery<T>;
  /** Loading placeholder, sized for the panel it stands in for. */
  skeleton: ReactNode;
  /** Rendered once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

/**
 * {@link QueryGate} for the Notion-style peek panels: no shell (the
 * `PeekPanel` is already the chrome), and `p-4` around the empty states
 * so they aren't flush against the panel edge.
 *
 * `AgentDetailPanel` and `TaskDetailPanel` each had this preamble
 * inline, with their own wording of both messages — see `QueryGate`'s
 * note on how far the copy had drifted from the pages'.
 */
export function PanelGate<T>({ icon, noun, id, query, skeleton, children }: Props<T>) {
  return (
    <QueryGate
      icon={icon}
      noun={noun}
      id={id}
      query={query}
      skeleton={skeleton}
      emptyClassName="p-4"
    >
      {children}
    </QueryGate>
  );
}
