import { api } from "@/lib/api/client";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useMemoryActivity(params: {
  weeks?: number;
  since?: string;
}) {
  return useApiQuery(queryKeys.memory.activity(params), ({ signal }) =>
    api.memory.activity({
      signal,
      weeks: params.weeks,
      since: params.since,
    }),
  );
}
