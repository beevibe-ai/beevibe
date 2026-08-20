import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useNegotiation(id: string | undefined) {
  return useDetailQuery({
    id,
    detailKey: queryKeys.negotiations.detail,
    allKey: queryKeys.negotiations.all,
    fetcher: (negId, ctx) => api.negotiations.get(negId, ctx),
  });
}
