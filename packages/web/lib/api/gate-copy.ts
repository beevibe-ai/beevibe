/**
 * Copy for the two states every API-backed view opens with: the API URL
 * isn't configured, and the fetch failed.
 *
 * `DetailGate` derived both from its `noun` so the seven detail pages
 * behind it could not word them differently. Everything that does not
 * render inside a `DetailShell` — the two peek panels, and the ten list
 * clients, each of which gates inside its own shell (a table row, a
 * kanban board, a pan/zoom canvas) — kept writing the strings out by
 * hand, and they drifted the same way the pages had before:
 *
 *   - One process, four names: "run the MCP server" (6 sites), "run the
 *     API server" (1), "run the api server" (1), and no clause at all
 *     (3). There is no MCP server to run; `/mcp` is a route on the API
 *     server, so the six MCP spellings sent the reader after a process
 *     that does not exist.
 *   - Five of the unconfigured branches titled themselves as *empty*
 *     data — "No facts learned yet", "No promotions yet", "No mesh asks
 *     yet" — which reads as "you have none of these" when the truth is
 *     "this build cannot reach the server". A user with a full database
 *     and an unset env var was told their data was missing.
 *
 * Both helpers take the tail of the sentence rather than deriving it,
 * because the subject genuinely varies (a list says "agents", a detail
 * page says "this task", the dashboard says "KPIs and fleet status");
 * what they fix is the half that should never have varied.
 */

/**
 * The "API URL isn't set" empty state. `what` completes the sentence
 * "…to load {what}." — lowercase, no trailing period.
 */
export function apiNotConfiguredCopy(what: string): {
  title: string;
  description: string;
} {
  return {
    title: "API not configured",
    description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${what}.`,
  };
}

/**
 * The "fetch failed" empty state for a single-row view. `noun` is the
 * lowercase singular ("task", "work product"); `id` is echoed back so a
 * failed fetch is identifiable in a screenshot or bug report.
 *
 * List views pass no `id` — there is no single row to name — and get the
 * title alone, which is what they already rendered.
 */
export function loadFailedCopy(
  noun: string,
  id?: string,
): { title: string; description?: string } {
  const title = `Couldn't load ${noun}`;
  if (id === undefined) return { title };
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    title,
    description: `${Noun} ${id} could not be fetched. Check the API server logs.`,
  };
}
