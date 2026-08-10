import { api } from "@/lib/api/client";
import { useApiDetailQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useApiDetailQuery({
    id,
    keyFor: queryKeys.negotiations.detail,
    fallbackKey: queryKeys.negotiations.all,
    fetch: (negotiationId, ctx) => api.negotiations.get(negotiationId, ctx),
  });
}
