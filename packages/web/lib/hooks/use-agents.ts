import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { detailQueryOptions } from "./detail-query";
import { queryKeys } from "./keys";

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => api.agents.list({ signal }),
    enabled: isApiConfigured,
  });
}

export function useAgent(id: string | undefined) {
  return useQuery(detailQueryOptions(queryKeys.agents, api.agents.get, id));
}
