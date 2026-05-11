"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import type { AgentNetwork } from "@/lib/types/agent-network";
import { queryKeys } from "./keys";

/**
 * Caller's own agents plus peer teams from rooms they share. Backs
 * the /agents page's full-network view (own orbit at the center,
 * peer team orbits around it).
 */
export function useAgentNetwork() {
  return useQuery<AgentNetwork>({
    queryKey: queryKeys.agentNetwork.self(),
    queryFn: ({ signal }) => api.agents.network({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });
}
