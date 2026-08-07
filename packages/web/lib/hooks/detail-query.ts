"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReadOptions } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The by-id fetch behind every detail page.
 *
 * `useTask`, `useAgent`, `useSession`, `useConversation`, `useEscalation`
 * and `useNegotiation` were the same six lines apiece: gate on
 * `isApiConfigured && !!id`, key on `detail(id)` while falling back to the
 * resource's `all` prefix when there is no id yet, and cast the id back to
 * a string inside `queryFn` because TanStack can't see that `enabled`
 * already excluded `undefined`.
 *
 * That cast is the reason this is worth sharing. It was written out six
 * times, and each copy is a place where changing `enabled` — dropping the
 * `!!id`, say, or adding another condition in front of it — turns a
 * disabled query into a `GET /task/undefined`. Here the assertion sits
 * next to the `enabled` clause that justifies it, so the two cannot be
 * edited apart.
 *
 * The `all`-prefix fallback matters for the same reason: while `id` is
 * undefined the query needs *some* key, and using the resource prefix
 * keeps the placeholder out of any real detail slot.
 */
export function useDetailQuery<T>(opts: {
  /** `undefined` while the route param is still resolving. */
  id: string | undefined;
  /** Per-resource key factory, e.g. `queryKeys.agents.detail`. */
  key: (id: string) => readonly unknown[];
  /** Key used while there is no id — the resource's `all` prefix. */
  fallbackKey: readonly unknown[];
  fetch: (id: string, options: ReadOptions) => Promise<T>;
  /** Passed straight through; omit for the client default. */
  staleTime?: number;
}) {
  const { id, key, fallbackKey, fetch, staleTime } = opts;
  return useQuery({
    queryKey: id ? key(id) : fallbackKey,
    // Safe: `enabled` below is false whenever `id` is undefined, so the
    // query function never runs without one.
    queryFn: ({ signal }) => fetch(id!, { signal }),
    enabled: isApiConfigured && !!id,
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}
