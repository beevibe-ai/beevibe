"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export interface UseRuntimesOptions {
  /**
   * Poll interval in ms. Off by default — SSE invalidates
   * `queryKeys.runtimes.list()` on `runtime.updated`, so the list stays
   * live without polling. The welcome wizard opts in because it is
   * waiting for a daemon that does not exist yet: there is no SSE
   * channel for "a runtime you don't have yet came online".
   */
  pollMs?: number;
  /** Keep polling while the tab is backgrounded. Requires `pollMs`. */
  pollInBackground?: boolean;
}

/**
 * Daemons and their runtimes for the caller.
 *
 * Four call sites — the /runtimes page, the agent-list runtime chip, and
 * both halves of the welcome wizard — each declared this query inline
 * against the same `queryKeys.runtimes.list()` key with a different set
 * of options. Sharing a cache key while diverging on options is the bad
 * case: the cache entry is shared, so the copies are not independent,
 * but nothing makes them agree. `welcome-client` had already noticed and
 * left a comment asking the next editor to keep its interval in step
 * with the other step's by hand.
 *
 * The divergence that mattered was `enabled` — only the /runtimes page
 * had the `isApiConfigured` guard, so the other three fired a fetch that
 * throws `ApiNotConfigured` when `NEXT_PUBLIC_BV_API_URL` is unset. The
 * guard is unconditional here; it is a no-op wherever the env var is
 * set, which is everywhere the other three were reachable in practice.
 *
 * `staleTime` was already uniformly 30s — three sites inherited it from
 * the `providers.tsx` default rather than stating it. It is explicit
 * here so the next change to that default doesn't move this query
 * silently.
 */
export function useRuntimes(opts: UseRuntimesOptions = {}) {
  return useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
    refetchInterval: opts.pollMs ?? false,
    refetchIntervalInBackground: opts.pollInBackground ?? false,
  });
}
