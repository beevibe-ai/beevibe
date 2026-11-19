"use client";

import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";
import type { ReadOptions } from "@/lib/api/client";

/**
 * The fetch-one-entity-by-id query every detail page runs.
 *
 * `useTask`, `useAgent`, `useSession`, `useEscalation` and `useNegotiation`
 * were five copies of the same four lines, and each carried an `id as
 * string` cast in its `queryFn`. The cast was load-bearing and unexplained:
 * the id is optional because a detail page can render before the route
 * param resolves, and `enabled: !!id` is what actually guarantees the
 * fetcher never sees `undefined`. Five unannotated casts standing on an
 * invariant expressed three lines above them is five chances for the next
 * hook to keep the cast and drop the guard — which type-checks and then
 * fetches `/task/undefined`.
 *
 * This states the invariant once and in a form the compiler enforces:
 * TanStack's `skipToken` replaces the `queryFn` outright while the id is
 * missing, so `fetch` is only ever reachable with a defined `id` and there
 * is no cast to get wrong.
 *
 * `fallbackKey` is the key used while the id is missing — the resource's
 * `all` prefix, matching what the hand-written hooks did. The query is
 * inert in that state, so the key only has to avoid colliding with a real
 * entry.
 */
export function useEntityQuery<T>(
  id: string | undefined,
  key: (id: string) => readonly unknown[],
  fallbackKey: readonly unknown[],
  fetch: (id: string, opts: ReadOptions) => Promise<T>,
  options: { staleTime?: number } = {},
): UseQueryResult<T, Error> {
  return useQuery({
    queryKey: id ? key(id) : fallbackKey,
    queryFn: id ? ({ signal }) => fetch(id, { signal }) : skipToken,
    enabled: isApiConfigured,
    ...options,
  });
}
