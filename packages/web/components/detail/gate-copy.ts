/**
 * The copy the three "load one thing by id" gates share.
 *
 * `DetailGate` (full detail route) and `PanelGate` (peek panel) show the
 * same two messages for the same two conditions, differing only in the
 * shell they render into. Deriving both sentences from `noun`/`id` in one
 * place is what stops them wording it differently — which is exactly what
 * had happened before: the detail routes said "Set NEXT_PUBLIC_BV_API_URL
 * and run the API server to load this task." while the peek panels said
 * "Set NEXT_PUBLIC_BV_API_URL to load this task.", and only the routes
 * ended the fetch error with "Check the API server logs."
 *
 * @param noun lowercase singular of what is being loaded — "task", "work product"
 * @param id   echoed into the error so a failed fetch is identifiable
 */
export function gateCopy(
  noun: string,
  id: string,
): {
  notConfigured: string;
  errorTitle: string;
  errorDescription: string;
} {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return {
    notConfigured: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`,
    errorTitle: `Couldn't load ${noun}`,
    errorDescription: `${Noun} ${id} could not be fetched. Check the API server logs.`,
  };
}
