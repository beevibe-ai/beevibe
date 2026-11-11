import { AlertTriangle, type LucideIcon } from "lucide-react";
import { isApiConfigured } from "@/lib/api/config";
import { EmptyState } from "@/components/empty-state";

/** The slice of a react-query result the gate branches on. */
export interface DetailQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Which of the four branches a detail surface is in, with the copy for
 * the two message branches already resolved.
 *
 * `DetailGate` renders these inside `DetailShell` for the full-page
 * routes. The peek panels and the room view can't use `DetailGate` —
 * they have their own chrome (`PeekPanel`, a flex-centered column) and
 * their own skeletons — so they consume this directly and wrap the
 * result themselves.
 */
export type DetailState<T> =
  | { kind: "unconfigured"; icon?: LucideIcon; title: string; description: string }
  | { kind: "loading" }
  | { kind: "error"; icon: LucideIcon; title: string; description: string }
  | { kind: "ready"; data: T };

/**
 * Resolve a detail query into its branch, deriving the "API not
 * configured" and "couldn't load" copy from `noun` and `id`.
 *
 * This is the same three-branch preamble `DetailGate` was written for,
 * factored out one level further so the surfaces that can't adopt the
 * `DetailShell` wrapper still can't word the messages their own way.
 * They had already drifted: the agent and task peek panels dropped
 * "and run the API server" from the unconfigured branch and the "Check
 * the API server logs." hint from the error branch, and the room view
 * rendered the unconfigured branch with no description at all.
 *
 * Deliberately a plain function, not a hook — call sites pass a query
 * they already have in hand, and a hook would constrain where it can
 * be called.
 *
 * Order matters: an unconfigured API is reported ahead of a failed
 * fetch, because with no API URL the fetch was never going to succeed
 * and "couldn't load" would send the reader after the wrong cause.
 * A query that settles without erroring and still hands back nothing
 * (a 404 mapped to `undefined`) lands on the error branch rather than
 * rendering a body with a missing row.
 */
export function detailState<T>(opts: {
  /** Lowercase singular of what the surface shows — "agent", "task", "room". */
  noun: string;
  /** Id echoed back in the error message so a failed fetch is identifiable. */
  id: string;
  /** Icon for the unconfigured branch. The error branch is always AlertTriangle. */
  icon?: LucideIcon;
  query: DetailQuery<T>;
}): DetailState<T> {
  const { noun, id, icon, query } = opts;

  if (!isApiConfigured) {
    return {
      kind: "unconfigured",
      icon,
      title: "API not configured",
      description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`,
    };
  }

  if (query.isLoading) return { kind: "loading" };

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      kind: "error",
      icon: AlertTriangle,
      title: `Couldn't load ${noun}`,
      description: `${Noun} ${id} could not be fetched. Check the API server logs.`,
    };
  }

  return { kind: "ready", data: query.data };
}

/**
 * Render the `EmptyState` for one of the two message branches.
 *
 * Narrowed to those two so a caller can't pass `loading` or `ready`
 * here and get a blank surface: both of those need the caller's own
 * markup (a layout-mirroring skeleton, the loaded body).
 */
export function DetailStateMessage({
  state,
}: {
  state: Extract<DetailState<unknown>, { kind: "unconfigured" | "error" }>;
}) {
  return (
    <EmptyState icon={state.icon} title={state.title} description={state.description} />
  );
}
