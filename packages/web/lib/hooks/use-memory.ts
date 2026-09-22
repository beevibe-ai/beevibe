import type { MemoryScope } from "@beevibe/core";
import { api } from "@/lib/api/client";
import type { FactCounts } from "@/lib/types/memory-facts";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useMemoryFacts(filter: { scope?: MemoryScope } = {}) {
  return useApiQuery(queryKeys.memory.facts(filter), ({ signal }) =>
    api.memory.listFacts(filter, { signal }),
  );
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
  return useApiQuery<FactCounts>(queryKeys.memory.counts(), ({ signal }) =>
    api.memory.factCounts({ signal }),
  );
}
