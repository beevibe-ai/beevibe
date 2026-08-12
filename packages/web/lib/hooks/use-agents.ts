import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { useApiDetailQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => api.agents.list({ signal }),
    enabled: isApiConfigured,
  });
}

export function useAgent(id: string | undefined) {
  return useApiDetailQuery({
    id,
    keyFor: queryKeys.agents.detail,
    fallbackKey: queryKeys.agents.all,
    fetch: (agentId, ctx) => api.agents.get(agentId, ctx),
  });
}
