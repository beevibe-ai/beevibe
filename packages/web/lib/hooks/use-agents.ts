import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => api.agents.list({ signal }),
    enabled: isApiConfigured,
  });
}

export function useAgent(id: string | undefined) {
  return useDetailQuery({
    id,
    detailKey: queryKeys.agents.detail,
    allKey: queryKeys.agents.all,
    fetcher: (agentId, ctx) => api.agents.get(agentId, ctx),
  });
}
