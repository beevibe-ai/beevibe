"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { DetailShell } from "@/components/detail/detail-shell";
import { EmptyState } from "@/components/empty-state";

interface Props<T> {
  /** The `useQuery` result backing the page. Only these three fields are read. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /** Back link rendered above every gate. Pages whose loaded state uses a
   *  different nav (work products swap in breadcrumbs) pass only the gate's. */
  nav?: ReactNode;
  /** Resource icon for the not-configured state. The error state always uses
   *  `AlertTriangle` — that was already uniform across all seven pages. */
  icon: LucideIcon;
  /** Lower-case noun for the copy: "task", "agent", "work product". */
  entity: string;
  /** Id echoed in the error copy, already shortened where the page shortens it. */
  entityId: string;
  /** Page-specific loading placeholder — the one part that legitimately differs. */
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * The load gate every detail page opens with: not-configured → loading →
 * error → data.
 *
 * Seven pages (`agents`, `tasks`, `escalations`, `negotiations`,
 * `work-products`, and both session detail clients) wrote out the same
 * three early-return branches, each repeating its `<DetailShell nav={…}>`
 * wrapper four times over. What actually varied was three values — the
 * icon, the noun, the skeleton — so the copy had drifted: the same
 * sentence told users to run "the api server", "the API server" or "the
 * MCP server" depending on which page they landed on, and three of the
 * seven appended "Check the … logs." while four didn't. Centralizing the
 * strings settles that on one wording.
 *
 * The loaded branch is deliberately NOT wrapped in a `DetailShell`: some
 * pages render their own with a different nav (work products swap the back
 * link for breadcrumbs), and some hand off to a `…DetailLoaded` component
 * that brings its own shell.
 */
export function DetailQuery<T>({
  query,
  nav,
  icon,
  entity,
  entityId,
  skeleton,
  children,
}: Props<T>) {
  if (!isApiConfigured) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the api server to load this ${entity}.`}
        />
      </DetailShell>
    );
  }

  if (query.isLoading) {
    return <DetailShell nav={nav}>{skeleton}</DetailShell>;
  }

  if (query.isError || !query.data) {
    const Entity = entity.charAt(0).toUpperCase() + entity.slice(1);
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${entity}`}
          description={`${Entity} ${entityId} could not be fetched. Check the api server logs.`}
        />
      </DetailShell>
    );
  }

  return <>{children(query.data)}</>;
}
