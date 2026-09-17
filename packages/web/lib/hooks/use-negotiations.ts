import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useNegotiation(id: string | undefined) {
  return useDetailQuery(id, queryKeys.negotiations, (negotiationId, opts) =>
    api.negotiations.get(negotiationId, opts),
  );
}
