import { api } from "@/lib/api/client";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useMemoryActivity(params: { weeks?: number; since?: string }) {
  return useCollectionQuery({
    queryKey: queryKeys.memory.activity(params),
    fetch: (opts) => api.memory.activity({ ...opts, weeks: params.weeks, since: params.since }),
  });
}
