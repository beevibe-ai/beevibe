/**
 * The two sentences every data-backed page shows when it has nothing to
 * render: "the browser was never pointed at an api server" and "the fetch
 * failed."
 *
 * `DetailGate` already derived these for the seven detail pages, and its doc
 * comment records why: written by hand per page, the copy drifts. That drift
 * came back on the list side, where no equivalent existed. One process was
 * called three different things depending on which page you happened to be
 * looking at —
 *
 *   - "run the MCP server"  — mesh, promotions, dashboard, memory, agents, tasks
 *   - "run the API server"  — runtimes, DetailGate
 *   - "run the api server"  — rooms
 *
 * — and the fetch-failure hint was present on some pages, absent on others,
 * and named a different process again where it did appear.
 *
 * "API server" is the spelling `DetailGate` had already standardized on
 * across seven pages, so it wins here rather than the more common "MCP
 * server": the MCP server is one router mounted inside the api process, not
 * the thing the user has to start.
 *
 * Both helpers return `EmptyState` props rather than rendered nodes — the
 * container differs per page (dashed-border box, table row, centered
 * overlay) and that difference is deliberate layout, not drift.
 */

export interface ApiStateCopy {
  title: string;
  description: string;
}

/**
 * `noun` is the thing the page would have shown, as a lowercase noun phrase
 * that reads after "to load": `"mesh activity"`, `"promotion events"`,
 * `"this task"`. Detail pages pass `` `this ${noun}` ``.
 */
export function apiNotConfiguredState(noun: string): ApiStateCopy {
  return {
    title: "API not configured",
    description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${noun}.`,
  };
}

/** Title for the "the fetch failed" state: "Couldn't load mesh activity". */
export function fetchFailedTitle(noun: string): string {
  return `Couldn't load ${noun}`;
}

/**
 * Default hint under {@link fetchFailedTitle}. Pages with something more
 * specific to say (a server-supplied error message) pass their own instead.
 */
export const FETCH_FAILED_HINT = "Check that the API server is reachable.";
