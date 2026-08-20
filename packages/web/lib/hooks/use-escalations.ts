import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useEscalation(id: string | undefined) {
  return useDetailQuery({
    id,
    detailKey: queryKeys.escalations.detail,
    allKey: queryKeys.escalations.all,
    fetcher: (escId, ctx) => api.escalations.get(escId, ctx),
  });
}
