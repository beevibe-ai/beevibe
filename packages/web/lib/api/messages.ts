/**
 * The two things every page says when it can't show data, in one place.
 *
 * Eleven surfaces — nine list pages, the detail gate, and the room detail
 * panel — each spelled out their own version of "the web isn't wired to a
 * backend" and "the backend didn't answer". The wording had drifted three
 * ways on the same process: "run the MCP server" (six pages), "run the api
 * server" (two), "run the API server" (one). There is one server; a user
 * comparing two pages should not have to guess whether they name the same
 * thing.
 *
 * The titles had drifted further, and misleadingly: an unconfigured web
 * showed "No mesh asks yet" / "No promotions yet" / "No facts learned yet"
 * — which reads as "your account is empty" when the truth is that
 * `NEXT_PUBLIC_BV_API_URL` was never set. {@link API_NOT_CONFIGURED_TITLE}
 * is what those branches say now.
 *
 * Only the copy is shared. Each page keeps its own envelope (a dashed-
 * border card, a table row spanning six columns, a centered shell), which
 * is genuinely per-layout and not worth a component seam.
 */

/** Title for the "no `NEXT_PUBLIC_BV_API_URL`" branch. */
export const API_NOT_CONFIGURED_TITLE = "API not configured";

/**
 * Description for the same branch. `noun` completes "…to load {noun}" —
 * lowercase, and the thing the page shows: "agents", "tasks", "mesh
 * activity", "this task".
 */
export function apiNotConfiguredDescription(noun: string): string {
  return `Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${noun}.`;
}

/** Title for the "configured, but the fetch failed" branch. */
export function couldNotLoadTitle(noun: string): string {
  return `Couldn't load ${noun}`;
}

/**
 * Description for the same branch. The api is configured, so the actionable
 * hint is about reachability rather than configuration.
 */
export const API_UNREACHABLE_DESCRIPTION =
  "The API is configured but didn't answer. Check that the API server is running.";
