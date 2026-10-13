"use client";

import { AlertTriangle, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * The two failure states a detail surface can be in before it has data,
 * with their canonical copy.
 *
 * `DetailGate` (full-page routes) and `PanelGate` (peek panels) both open
 * with the same three-branch preamble — not configured, loading, failed —
 * and the two failure branches say the same two things. Keeping the prose
 * here rather than in each gate is the same reasoning `DetailGate`'s own
 * doc comment gives for existing at all: when the wording lives at the
 * call site it drifts. It already had. Before this module the peek panels
 * carried their own copies, which is why they said "Set
 * NEXT_PUBLIC_BV_API_URL to load this agent." where the routes said "Set
 * NEXT_PUBLIC_BV_API_URL and run the API server to load this task.", and
 * dropped the "Check the API server logs." hint the routes give.
 *
 * Both messages are derived from `noun`, so a surface can't word them a
 * third way without editing this file.
 */
export function ApiNotConfiguredState({
  noun,
  icon,
}: {
  /** Lowercase singular of what the surface shows — "task", "agent". */
  noun: string;
  icon?: LucideIcon;
}) {
  return (
    <EmptyState
      icon={icon}
      title="API not configured"
      description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
    />
  );
}

export function LoadFailedState({ noun, id }: { noun: string; id: string }) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <EmptyState
      icon={AlertTriangle}
      title={`Couldn't load ${noun}`}
      description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
    />
  );
}
