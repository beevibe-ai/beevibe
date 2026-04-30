import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    enabled: isApiConfigured,
  });
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.agents.detail(id) : queryKeys.agents.all,
    queryFn: () => api.agents.get(id as string),
    enabled: isApiConfigured && !!id,
  });
}
