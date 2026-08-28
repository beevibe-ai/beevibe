"use client";

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { DetailShell } from "./detail-shell";
import { EmptyState } from "@/components/empty-state";

interface GateInputs<T> {
  /** Icon for the "API not configured" state. The error state is always AlertTriangle. */
  icon?: LucideIcon;
  /** Lowercase singular of what the surface shows — "task", "work product". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** The react-query result driving the surface. */
  query: { data: T | undefined; isLoading: boolean; isError: boolean };
  /**
   * Loading placeholder. Per-surface rather than generic: the skeleton mirrors
   * the layout it stands in for, so a shared one would jump on hydration.
   */
  skeleton: ReactNode;
}

interface Props<T> extends GateInputs<T> {
  /**
   * Breadcrumb or back-link, rendered above the body in every state so the
   * user can navigate away from a page that failed to load. Pages whose
   * breadcrumb needs the fetched row pass `data ? <Crumbs row={data}/> : undefined`.
   */
  nav?: ReactNode;
  /** Rendered inside the shell once the fetch succeeded. */
  children: (data: T) => ReactNode;
}

type GateState<T> =
  | { status: "unconfigured"; message: ReactNode }
  | { status: "loading" }
  | { status: "failed"; message: ReactNode }
  | { status: "ready"; data: T };

/**
 * Resolve which of the four states a detail surface is in, and word the two
 * message states.
 *
 * Kept separate from the components below so the page shell and the peek
 * panel can lay the states out differently — full-width inside a
 * `DetailShell` vs. padded inside a slide-over — without either one
 * re-deciding what "not loaded" means or re-wording what it says.
 */
function gateState<T>({ icon, noun, id, query }: GateInputs<T>): GateState<T> {
  if (!isApiConfigured) {
    return {
      status: "unconfigured",
      message: (
        <EmptyState
          icon={icon}
          title="API not configured"
          description={`Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`}
        />
      ),
    };
  }

  if (query.isLoading) return { status: "loading" };

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      status: "failed",
      message: (
        <EmptyState
          icon={AlertTriangle}
          title={`Couldn't load ${noun}`}
          description={`${Noun} ${id} could not be fetched. Check the API server logs.`}
        />
      ),
    };
  }

  return { status: "ready", data: query.data };
}

/**
 * The three-branch preamble every detail page opens with — API not
 * configured, still loading, failed to load — plus the `DetailShell` all
 * four states share.
 *
 * Written out by hand on each page before this existed, which is why the
 * copy had drifted: the same condition variously said "run the API server",
 * "run the api server" and "run the MCP server" (one process, three names),
 * and half the pages ended the fetch error with "Check the MCP server logs"
 * while the other half dropped the hint. Both messages are derived from
 * `noun` here, so a page can't word them a fourth way.
 */
export function DetailGate<T>({ nav, skeleton, children, ...inputs }: Props<T>) {
  const state = gateState({ ...inputs, skeleton });
  return (
    <DetailShell nav={nav}>
      {state.status === "loading"
        ? skeleton
        : state.status === "ready"
          ? children(state.data)
          : state.message}
    </DetailShell>
  );
}

/**
 * {@link DetailGate} for a peek panel — the same four states, laid out for a
 * slide-over instead of a page.
 *
 * The agent and task panels had each written the preamble out inline, which
 * is how the wording DetailGate exists to keep singular acquired a fourth
 * and fifth variant anyway: the panels said "Set NEXT_PUBLIC_BV_API_URL to
 * load this agent." and dropped the "Check the API server logs" hint from
 * the fetch error. Routing them through the same `gateState` puts every
 * surface back on one set of strings.
 *
 * Padding differs per state because the states differ in kind: an
 * `EmptyState` centers its own content and wants the panel's `p-4` gutter,
 * while the skeleton stands in for the loaded body's `p-5` block.
 */
export function PanelGate<T>({
  skeleton,
  children,
  ...inputs
}: Omit<Props<T>, "nav">) {
  const state = gateState({ ...inputs, skeleton });

  if (state.status === "ready") return <>{children(state.data)}</>;
  if (state.status === "loading") return <div className="p-5 space-y-4">{skeleton}</div>;
  return <div className="p-4">{state.message}</div>;
}
