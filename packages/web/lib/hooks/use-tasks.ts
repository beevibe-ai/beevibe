import { api, type TaskListFilter } from "@/lib/api/client";
import { useCollectionQuery, useEntityQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useTasks(filter: TaskListFilter = {}) {
  return useCollectionQuery({
    queryKey: queryKeys.tasks.list(filter),
    fetch: (opts) => api.tasks.list(filter, opts),
    // Always refetch when the user lands on /tasks. The default
    // staleTime: 30_000 (providers.tsx) combined with mount-with-cached-
    // data semantics means /chat → /tasks could render the previous
    // empty-or-stale list without firing a fetch. SSE invalidation
    // *should* mark the cache stale and trigger a refetch, but a missed
    // event (proxy buffering, brief disconnect, race between SSE connect
    // and task creation) leaves the user staring at an empty board.
    // Treat /tasks navigation as a "give me the latest" signal — one
    // SQL query per visit is negligible and the freshness guarantee
    // matters more on this surface than the cache hit.
    refetchOnMount: "always",
  });
}

export function useTask(id: string | undefined) {
  return useEntityQuery({
    id,
    queryKey: queryKeys.tasks.detail,
    disabledKey: queryKeys.tasks.all,
    fetch: api.tasks.get,
  });
}
