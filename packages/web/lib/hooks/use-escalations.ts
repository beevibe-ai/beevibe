import { api } from "@/lib/api/client";
import { useDetailQuery } from "./use-detail-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useDetailQuery(id, queryKeys.escalations, api.escalations.get);
}
