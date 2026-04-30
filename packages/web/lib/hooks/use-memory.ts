import { useQuery } from "@tanstack/react-query";
import type { MemoryScope } from "@beevibe/core";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useMemoryFacts(filter: { scope?: MemoryScope } = {}) {
  return useQuery({
    queryKey: queryKeys.memory.facts(filter),
    queryFn: ({ signal }) => api.memory.listFacts(filter, { signal }),
    enabled: isApiConfigured,
  });
}
