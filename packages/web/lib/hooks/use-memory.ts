import { useQuery } from "@tanstack/react-query";
import type { MemoryScope } from "@beevibe/core";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import type { FactCounts } from "@/lib/types/memory-facts";
import { queryKeys } from "./keys";

export function useMemoryFacts(filter: { scope?: MemoryScope } = {}) {
  return useQuery({
    queryKey: queryKeys.memory.facts(filter),
    queryFn: ({ signal }) => api.memory.listFacts(filter, { signal }),
    enabled: isApiConfigured,
  });
}

/**
 * Per-scope counts for the memory page's tab badges. Owner-scoped on
 * the server and independent of the active scope filter, so the badges
 * keep showing the true cardinality of each scope while the list below
 * narrows. Shares the `["memory"]` invalidation prefix with the facts
 * query so `memory.fact.created` / `memory.fact.deleted` SSE refresh
 * both at once.
 */
export function useMemoryFactCounts() {
  return useQuery<FactCounts>({
    queryKey: queryKeys.memory.counts(),
    queryFn: ({ signal }) => api.memory.factCounts({ signal }),
    enabled: isApiConfigured,
  });
}
