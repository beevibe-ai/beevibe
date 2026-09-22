"use client";

import { api } from "@/lib/api/client";
import type { AgentNetwork } from "@/lib/types/agent-network";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

/**
 * Caller's own agents plus peer teams from rooms they share. Backs
 * the /agents page's full-network view (own orbit at the center,
 * peer team orbits around it).
 */
export function useAgentNetwork() {
  return useApiQuery<AgentNetwork>(
    queryKeys.agentNetwork.self(),
    ({ signal }) => api.agents.network({ signal }),
    { staleTime: 30_000 },
  );
}
