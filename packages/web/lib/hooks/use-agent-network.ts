"use client";

import { api } from "@/lib/api/client";
import type { AgentNetwork } from "@/lib/types/agent-network";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

/**
 * Caller's own agents plus peer teams from rooms they share. Backs
 * the /agents page's full-network view (own orbit at the center,
 * peer team orbits around it).
 */
export function useAgentNetwork() {
  return useCollectionQuery<AgentNetwork>({
    queryKey: queryKeys.agentNetwork.self(),
    fetch: api.agents.network,
    staleTime: 30_000,
  });
}
