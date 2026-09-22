import { api } from "@/lib/api/client";
import { useApiDetailQuery, useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useAgents() {
  return useApiQuery(queryKeys.agents.list(), ({ signal }) => api.agents.list({ signal }));
}

export function useAgent(id: string | undefined) {
  return useApiDetailQuery(id, queryKeys.agents, (agentId, opts) =>
    api.agents.get(agentId, opts),
  );
}
