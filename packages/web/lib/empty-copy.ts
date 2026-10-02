/**
 * The two sentences every unpopulated page shows, in one place.
 *
 * Each page used to spell these out by hand, and the copy had drifted
 * badly: the "API not configured" line variously said "run the API
 * server", "run the api server" and "run the MCP server" — one process,
 * three names — while four pages dropped the server clause entirely and
 * one shrank to a bare "Set NEXT_PUBLIC_BV_API_URL.". The fetch-failure
 * line had the same spread, half of them ending with a "check the logs"
 * hint and half without.
 *
 * `DetailGate` fixed this for the detail pages by deriving both messages
 * from a noun. These helpers are that same derivation, lifted out so the
 * overview pages — whose layouts differ too much to share a component —
 * can reuse the wording without the layout.
 *
 * "API server" is the canonical name: `packages/api` serves the REST API
 * and the MCP server from one process, and "MCP server" naming it was
 * always the misnomer.
 */

export interface EmptyCopy {
  title: string;
  description: string;
}

/**
 * Shown when `NEXT_PUBLIC_BV_API_URL` is unset, so the web app has no API
 * to talk to at all.
 *
 * `target` completes the sentence "…to load ___" and should read as an
 * object phrase: `"this task"`, `"mesh activity"`, `"KPIs and fleet
 * status"`.
 */
export function apiNotConfiguredCopy(target: string): EmptyCopy {
  return {
    title: "API not configured",
    description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load ${target}.`,
  };
}

/**
 * Shown when the API is configured but the fetch failed.
 *
 * `noun` is the lowercase singular of what the page shows ("task",
 * "mesh activity"). `id` is echoed back when the page is about one
 * identifiable row, so a failed fetch is traceable in the server logs.
 */
export function loadFailedCopy(noun: string, id?: string): EmptyCopy {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    title: `Couldn't load ${noun}`,
    description: id
      ? `${Noun} ${id} could not be fetched. Check the API server logs.`
      : `${Noun} could not be fetched. Check the API server logs.`,
  };
}
