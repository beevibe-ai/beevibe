import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The two query keys a detail hook needs: the per-id slot it caches
 * into, and the resource-wide prefix it parks on while the id is still
 * undefined (so the disabled query doesn't squat on a real slot).
 */
export interface DetailQueryKeys {
  all: readonly unknown[];
  detail: (id: string) => readonly unknown[];
}

/**
 * A single entity fetched by id, where the id may not be known yet.
 *
 * Six hooks — `useAgent`, `useTask`, `useSession`, `useConversation`,
 * `useEscalation`, `useNegotiation` — were the same eight lines with the
 * resource name swapped: key on the id when present and the resource
 * prefix when not, fetch by id, and stay disabled until both the api is
 * configured and the id has arrived.
 *
 * Each copy also carried an `id as string` cast in its `queryFn`, because
 * `enabled` is a runtime gate that TypeScript cannot see through. Six
 * casts is six places asserting an invariant that only one of them needs
 * to state: this throws instead, which is unreachable while `enabled`
 * holds and is a legible error rather than an `undefined` in a URL path
 * if some future caller ever drops the gate.
 */
export function useDetailQuery<T>(
  id: string | undefined,
  keys: DetailQueryKeys,
  fetchById: (id: string, opts: { signal?: AbortSignal }) => Promise<T>,
  options: { staleTime?: number } = {},
): UseQueryResult<T> {
  return useQuery({
    queryKey: id ? keys.detail(id) : keys.all,
    queryFn: ({ signal }) => {
      // Unreachable: `enabled` below keeps the query from running
      // without an id. Stated as a throw rather than a cast so the
      // invariant is checked instead of asserted.
      if (!id) throw new Error("useDetailQuery: ran without an id");
      return fetchById(id, { signal });
    },
    enabled: isApiConfigured && !!id,
    ...options,
  });
}
