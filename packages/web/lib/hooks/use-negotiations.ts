import { api } from "@/lib/api/client";
import { useApiDetailQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useApiDetailQuery(id, queryKeys.negotiations, (negotiationId, opts) =>
    api.negotiations.get(negotiationId, opts),
  );
}
