import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useMemoryActivity(params: {
  weeks?: number;
  since?: string;
}) {
  return useQuery({
    queryKey: queryKeys.memory.activity(params),
    queryFn: ({ signal }) =>
      api.memory.activity({
        signal,
        weeks: params.weeks,
        since: params.since,
      }),
    enabled: isApiConfigured,
  });
}
