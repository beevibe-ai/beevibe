import type { MemoryScope } from "@beevibe/core";
import { api } from "@/lib/api/client";
import type { FactCounts } from "@/lib/types/memory-facts";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useMemoryFacts(filter: { scope?: MemoryScope } = {}) {
  return useCollectionQuery({
    queryKey: queryKeys.memory.facts(filter),
    fetch: (opts) => api.memory.listFacts(filter, opts),
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
  return useCollectionQuery<FactCounts>({
    queryKey: queryKeys.memory.counts(),
    fetch: api.memory.factCounts,
  });
}
