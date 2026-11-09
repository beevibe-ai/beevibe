import { api } from "@/lib/api/client";
import { useDetailQuery } from "./use-detail-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useDetailQuery(id, queryKeys.negotiations, api.negotiations.get);
}
