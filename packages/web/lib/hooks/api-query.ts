"use client";

import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The two `useQuery` shapes every data hook in this app is an instance of.
 *
 * Both exist because of one invariant: nothing may fetch when
 * `NEXT_PUBLIC_BV_API_URL` is unset. `api/http.ts` throws in that case, so a
 * hook that forgets `enabled: isApiConfigured` turns a "not configured" page
 * into an error page. That guard was written out by hand at 26 call sites —
 * one omission was all it took to break a surface, and nothing made the rule
 * visible to the next hook someone added.
 *
 * Everything else about a hook — its key, its fetcher, its `select`,
 * `staleTime`, `refetchInterval` — stays at the call site, where the
 * page-specific reasoning for it already lives. These helpers own the gate
 * and nothing more.
 */

/**
 * Options a caller may still pass through. `queryKey` and `queryFn` are
 * supplied by the helper's own arguments; `enabled` is narrowed to a plain
 * boolean that is ANDed with the API-configured gate rather than replacing
 * it, so a call site can add a condition but can't drop the invariant.
 */
type PassthroughOptions<T, TData> = Omit<
  UseQueryOptions<T, Error, TData, QueryKey>,
  "queryKey" | "queryFn" | "enabled"
> & {
  /** Extra precondition, ANDed with `isApiConfigured`. Default: true. */
  enabled?: boolean;
};

/**
 * A list / singleton query: fetches as soon as the API is configured.
 *
 * ```ts
 * useApiQuery(queryKeys.agents.list(), ({ signal }) => api.agents.list({ signal }))
 * ```
 */
export function useApiQuery<T, TData = T>(
  queryKey: QueryKey,
  fetch: (opts: { signal: AbortSignal }) => Promise<T>,
  options: PassthroughOptions<T, TData> = {},
): UseQueryResult<TData, Error> {
  const { enabled = true, ...rest } = options;
  return useQuery<T, Error, TData, QueryKey>({
    queryKey,
    queryFn: ({ signal }) => fetch({ signal }),
    enabled: isApiConfigured && enabled,
    ...rest,
  });
}

/**
 * Key namespace for a resource that has per-id detail rows. Taken as a
 * whole rather than as two loose arguments so `queryKeys.tasks` can be
 * handed over directly; `useConversation` passes a spliced one because its
 * key factory is `sessions.conversation`, not `sessions.detail`.
 */
export interface DetailKeys {
  /** Prefix key, used as an inert placeholder while `id` is undefined. */
  all: QueryKey;
  detail: (id: string) => QueryKey;
}

/**
 * A detail query keyed by a route param that may not be resolved yet.
 *
 * While `id` is undefined the query is disabled and parks on the resource's
 * prefix key — a react-query `queryKey` is required even when nothing will
 * be fetched, and the prefix is inert (no hook reads it) so the parked entry
 * can't collide with a real row.
 *
 * ```ts
 * useApiDetailQuery(id, queryKeys.tasks, (taskId, opts) => api.tasks.get(taskId, opts))
 * ```
 */
export function useApiDetailQuery<T, TData = T>(
  id: string | undefined,
  keys: DetailKeys,
  fetch: (id: string, opts: { signal: AbortSignal }) => Promise<T>,
  options: PassthroughOptions<T, TData> = {},
): UseQueryResult<TData, Error> {
  const { enabled = true, ...rest } = options;
  return useQuery<T, Error, TData, QueryKey>({
    queryKey: id ? keys.detail(id) : keys.all,
    queryFn: ({ signal }) => {
      // Unreachable: `enabled` is false without an id. Throwing rather than
      // asserting `id as string` (which is what all six detail hooks did)
      // means a future `enabled` override that accidentally lets this run
      // surfaces as a query error instead of a request to `/tasks/undefined`.
      if (!id) throw new Error("useApiDetailQuery: ran without an id");
      return fetch(id, { signal });
    },
    enabled: isApiConfigured && !!id && enabled,
    ...rest,
  });
}
