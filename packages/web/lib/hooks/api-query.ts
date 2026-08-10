"use client";

import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";

/**
 * Everything a caller may still pass through, minus the three fields these
 * factories own (`queryKey`, `queryFn`, `enabled`). `select`, `staleTime`,
 * `refetchOnMount`, `refetchInterval` and friends all still work.
 */
type ApiQueryExtras<TQueryFnData, TData> = Omit<
  UseQueryOptions<TQueryFnData, Error, TData>,
  "queryKey" | "queryFn" | "enabled"
> & {
  /** ANDed with the factory's own gate rather than replacing it. Default true. */
  enabled?: boolean;
};

/**
 * `useQuery` with the `isApiConfigured` gate applied.
 *
 * Every read hook in this directory gates on it — without a configured
 * `NEXT_PUBLIC_BV_API_URL`, `fetchJson` throws `ApiNotConfigured`, so an
 * ungated query renders an error state instead of staying idle.
 */
export function useApiQuery<TQueryFnData, TData = TQueryFnData>(
  queryKey: QueryKey,
  queryFn: (ctx: { signal: AbortSignal }) => Promise<TQueryFnData>,
  extras: ApiQueryExtras<TQueryFnData, TData> = {},
): UseQueryResult<TData, Error> {
  const { enabled = true, ...rest } = extras;
  return useQuery<TQueryFnData, Error, TData>({
    ...rest,
    queryKey,
    queryFn: ({ signal }) => queryFn({ signal }),
    enabled: isApiConfigured && enabled,
  });
}

/**
 * The "fetch one entity by id" read hook.
 *
 * Six hooks — `useTask`, `useAgent`, `useSession`, `useConversation`,
 * `useEscalation`, `useNegotiation` — plus the inline copy in the
 * work-product detail page all spelled out the same three-part dance:
 *
 *   1. key off `detail(id)` when there's an id, else fall back to the
 *      resource's `all` prefix, because a `queryKey` is required even while
 *      the query is disabled;
 *   2. gate `enabled` on `!!id`;
 *   3. cast `id as string` inside `queryFn`, since TypeScript can't see that
 *      (2) makes (3) safe.
 *
 * That cast is the reason to have this: it was written out six times, and it
 * is only sound as long as the `enabled` gate three lines above it is
 * present. Here the gate and the cast are adjacent and can't drift apart.
 */
export function useApiDetailQuery<TQueryFnData, TData = TQueryFnData>({
  id,
  keyFor,
  fallbackKey,
  fetch,
  ...extras
}: {
  id: string | undefined;
  /** Per-id query key, e.g. `queryKeys.tasks.detail`. */
  keyFor: (id: string) => QueryKey;
  /**
   * Key used while `id` is undefined. The resource's `all` prefix — the
   * query is disabled, so this slot is never populated; it just has to be
   * stable and not collide with a real detail slot.
   */
  fallbackKey: QueryKey;
  fetch: (id: string, ctx: { signal: AbortSignal }) => Promise<TQueryFnData>;
} & ApiQueryExtras<TQueryFnData, TData>): UseQueryResult<TData, Error> {
  const { enabled = true, ...rest } = extras;
  return useApiQuery<TQueryFnData, TData>(
    id ? keyFor(id) : fallbackKey,
    // Safe: `enabled` below gates on `id`, so this never runs without one.
    ({ signal }) => fetch(id as string, { signal }),
    { ...rest, enabled: !!id && enabled },
  );
}
