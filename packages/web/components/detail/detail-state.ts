import { isApiConfigured } from "@/lib/api/config";

/**
 * The four states every detail surface resolves to, with the user-facing
 * copy already derived.
 *
 * This is the headless half of {@link DetailGate} / {@link PanelGate}: the
 * branch order and the wording live here, the chrome lives in the two
 * renderers. Splitting them is what lets a peek panel and a full page share
 * one definition of "what does an unloadable detail view say" while keeping
 * their own padding and wrappers.
 */
export type DetailState<T> =
  | { kind: "unconfigured"; title: string; description: string }
  | { kind: "loading" }
  | { kind: "error"; title: string; description: string }
  | { kind: "ready"; data: T };

/** The react-query result shape the detail surfaces drive off. */
export interface DetailQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Resolve a detail query into one of the four {@link DetailState}s.
 *
 * Two invariants this centralizes, both of which had already been broken by
 * hand-written copies:
 *
 *  - **Branch order.** The unconfigured check comes first, so a missing
 *    `NEXT_PUBLIC_BV_API_URL` reports itself rather than surfacing as a
 *    mystery fetch failure.
 *  - **Wording.** The same condition had been described as "run the API
 *    server", "run the api server" and "run the MCP server" (one process,
 *    three names), and the fetch error variously did and didn't end with the
 *    "check the logs" hint. Both strings are derived from `noun` here, so a
 *    surface can't word them a fourth way.
 *
 * A settled-but-empty query (a 404 mapped to `undefined`) resolves to
 * `error`, never `ready` — callers get a non-optional `data` on the happy
 * path and so can't render a body around a missing row.
 */
export function resolveDetailState<T>(
  noun: string,
  id: string,
  query: DetailQuery<T>,
): DetailState<T> {
  if (!isApiConfigured) {
    return {
      kind: "unconfigured",
      title: "API not configured",
      description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`,
    };
  }

  if (query.isLoading) return { kind: "loading" };

  if (query.isError || !query.data) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      kind: "error",
      title: `Couldn't load ${noun}`,
      description: `${Noun} ${id} could not be fetched. Check the API server logs.`,
    };
  }

  return { kind: "ready", data: query.data };
}
