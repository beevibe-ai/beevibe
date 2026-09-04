import { api } from "@/lib/api/client";
import { useCollectionQuery, useEntityQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useAgents() {
  return useCollectionQuery({
    queryKey: queryKeys.agents.list(),
    fetch: api.agents.list,
  });
}

export function useAgent(id: string | undefined) {
  return useEntityQuery({
    id,
    queryKey: queryKeys.agents.detail,
    disabledKey: queryKeys.agents.all,
    fetch: api.agents.get,
  });
}
