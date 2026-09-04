import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import type { ReadOptions } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The "one entity, addressed by an id that may not be there yet" query.
 *
 * Eight call sites — `useTask`, `useAgent`, `useSession`, `useConversation`,
 * `useEscalation`, `useNegotiation`, plus the room and work-product detail
 * clients — had each written out the same four lines:
 *
 * ```ts
 * useQuery({
 *   queryKey: id ? queryKeys.x.detail(id) : queryKeys.x.all,
 *   queryFn: ({ signal }) => api.x.get(id as string, { signal }),
 *   enabled: isApiConfigured && !!id,
 * })
 * ```
 *
 * Three things are easy to get wrong when writing that by hand, and all
 * three are invisible until runtime:
 *
 * - Dropping `isApiConfigured` from `enabled` fires a fetch at a null base
 *   URL on a deployment that has no api configured.
 * - Dropping `!!id` fires a fetch at `/undefined`.
 * - The `id as string` cast in `queryFn` is only sound *because* `enabled`
 *   gates it. The cast and the guard that justifies it sat in different
 *   properties of the same object literal, repeated six times, with nothing
 *   tying them together.
 *
 * Here the guard and the cast are adjacent, written once, and every caller
 * inherits them. Callers pass the remaining useQuery options through —
 * `staleTime`, `select`, `refetchInterval` — so the per-surface tuning that
 * motivated several of these hooks survives verbatim.
 */
export function useEntityQuery<TData, TSelected = TData>({
  id,
  queryKey,
  disabledKey,
  fetch,
  ...options
}: {
  /** The entity id. `undefined` while the route param is still resolving. */
  id: string | undefined;
  /** Cache key for a present id. */
  queryKey: (id: string) => readonly unknown[];
  /**
   * Cache key used while `id` is absent. The query is disabled then, so
   * this slot is never written; it exists because `queryKey` is required.
   * Convention is the entity's `all` prefix.
   */
  disabledKey: readonly unknown[];
  /** The api client read for this entity. */
  fetch: (id: string, options: ReadOptions) => Promise<TData>;
} & Omit<
  UseQueryOptions<TData, Error, TSelected>,
  "queryKey" | "queryFn" | "enabled"
>): UseQueryResult<TSelected, Error> {
  const hasId = id !== undefined && id !== "";
  return useQuery<TData, Error, TSelected>({
    queryKey: hasId ? queryKey(id) : disabledKey,
    // Sound because `enabled` below is false whenever `hasId` is —
    // react-query never invokes queryFn for a disabled query.
    queryFn: ({ signal }) => fetch(id as string, { signal }),
    enabled: isApiConfigured && hasId,
    ...options,
  });
}

/**
 * The "whole collection" counterpart: no id to wait on, so the only shared
 * concern is gating on a configured api. Seventeen call sites repeated
 * `enabled: isApiConfigured`; the value of routing them through here is
 * that adding a global read concern later (a signed-out guard, say) is one
 * edit rather than seventeen.
 */
export function useCollectionQuery<TData, TSelected = TData>({
  queryKey,
  fetch,
  ...options
}: {
  queryKey: readonly unknown[];
  fetch: (options: ReadOptions) => Promise<TData>;
} & Omit<
  UseQueryOptions<TData, Error, TSelected>,
  "queryKey" | "queryFn" | "enabled"
>): UseQueryResult<TSelected, Error> {
  return useQuery<TData, Error, TSelected>({
    queryKey,
    queryFn: ({ signal }) => fetch({ signal }),
    enabled: isApiConfigured,
    ...options,
  });
}
