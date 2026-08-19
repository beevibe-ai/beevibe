import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { type ReadOptions } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The "fetch one entity by id" query shape, in one place.
 *
 * Five hooks — `useAgent`, `useSession`, `useTask`, `useEscalation`,
 * `useNegotiation` — were byte-identical bar the resource name: take an
 * optional id, key on `detail(id)` when present and fall back to the
 * resource's `all` key when not, fetch via `api.<resource>.get(id, {signal})`,
 * and stay disabled until both the api is configured and an id exists. The
 * `id ? … : all` branch, the `id as string` cast (safe only because
 * `enabled` gates on `!!id`), and the `enabled` guard were spelled out at
 * every site — five chances to let one drift (e.g. forget the `!!id` guard
 * and fire a request for `/agent/undefined`).
 *
 * `detailKey` / `allKey` come from `queryKeys`, and `fetcher` is the
 * matching `api.<resource>.get`; the result type `T` is inferred from the
 * fetcher, so each hook keeps its exact return shape with no consumer
 * changes.
 *
 * Hooks with extra per-resource options (e.g. `useConversation`'s
 * `staleTime`) keep their own `useQuery` call — this covers only the plain
 * detail shape.
 */
export function useDetailQuery<T>(
  id: string | undefined,
  detailKey: (id: string) => readonly unknown[],
  allKey: readonly unknown[],
  fetcher: (id: string, opts: ReadOptions) => Promise<T>,
): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: id ? detailKey(id) : allKey,
    queryFn: ({ signal }) => fetcher(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
