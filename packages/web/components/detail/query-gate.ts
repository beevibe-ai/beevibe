import { isApiConfigured } from "@/lib/api/config";

export interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * The four states every id-addressed surface resolves to, with the two
 * failure states' copy already derived.
 */
export type GateState<T> =
  | { kind: "unconfigured"; title: string; description: string }
  | { kind: "loading" }
  | { kind: "error"; title: string; description: string }
  | { kind: "ready"; data: T };

/**
 * The not-configured → loading → failed → ready decision, plus the wording
 * of the two failure messages, as data rather than as JSX.
 *
 * `DetailGate` (#277) centralized this for the seven detail *pages*, which
 * all share a `DetailShell`. The two Notion-style peek panels —
 * `AgentDetailPanel`, `TaskDetailPanel` — open with the same four branches
 * in the same order but cannot use it: their chrome is a bare padding
 * wrapper inside a `PeekPanel`, not a shell with a nav. So they each kept a
 * hand-written copy, and the copy drifted exactly the way #277 described:
 * the panels tell you to "Set NEXT_PUBLIC_BV_API_URL to load this agent"
 * where the pages say "Set NEXT_PUBLIC_BV_API_URL and run the API server
 * to load this agent", and the panels' fetch error drops the "Check the API
 * server logs." hint the pages end with. One process, two sets of
 * instructions, decided by whether you clicked a row or opened its page.
 *
 * Splitting the decision from the chrome lets both render their own
 * wrapper around one source of copy. The icon and the loading placeholder
 * stay with the caller: the skeleton mirrors the layout it stands in for,
 * and a shared one would jump on hydration.
 *
 * Branch order matters and is the reason this is one function rather than
 * a convention. `isApiConfigured` is checked first because an unconfigured
 * client also reports `isError`, and reporting the fetch failure would send
 * the user to look at logs for a server they never pointed at.
 */
export function gateState<T>(
  noun: string,
  id: string,
  query: QueryLike<T>,
): GateState<T> {
  if (!isApiConfigured) {
    return {
      kind: "unconfigured",
      title: "API not configured",
      description: `Set NEXT_PUBLIC_BV_API_URL and run the API server to load this ${noun}.`,
    };
  }
  if (query.isLoading) return { kind: "loading" };
  if (query.isError || query.data === undefined) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      kind: "error",
      title: `Couldn't load ${noun}`,
      description: `${Noun} ${id} could not be fetched. Check the API server logs.`,
    };
  }
  return { kind: "ready", data: query.data };
}
