"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type RuntimesListResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

/**
 * Daemons and the runtimes they advertise.
 *
 * Four call sites had their own `useQuery` on `queryKeys.runtimes.list()`
 * with four different option sets — /runtimes, the runtime picker chip,
 * and both of the welcome wizard's daemon steps. Because they share the
 * key they share a cache entry, so the differences weren't local: two of
 * them omitted `enabled: isApiConfigured` and would throw
 * `ApiNotConfigured` out of the query function (every 3s, in the wizard's
 * case) on a web build with no api URL, and the wizard's two polling
 * steps disagreed about `refetchIntervalInBackground` despite a comment
 * on the second one asking for the same cadence as the first.
 *
 * `poll` is the one knob that genuinely varies: the wizard waits for a
 * daemon to appear and wants 3s polling, everything else relies on the
 * `runtime.updated` SSE event invalidating the key.
 */
export function useRuntimes(opts: { poll?: boolean } = {}) {
  return useQuery<RuntimesListResponse>({
    queryKey: queryKeys.runtimes.list(),
    queryFn: ({ signal }) => api.runtimes.list({ signal }),
    enabled: isApiConfigured,
    // SSE invalidates this key on `runtime.updated`; keep the cache
    // otherwise long so per-render polling doesn't fight the live updates.
    staleTime: 30_000,
    // The wizard's steps are a "waiting for your daemon to phone home"
    // screen, so they keep polling while the tab is backgrounded —
    // installing the daemon means leaving the browser for a terminal.
    ...(opts.poll ? { refetchInterval: 3_000, refetchIntervalInBackground: true } : {}),
  });
}
