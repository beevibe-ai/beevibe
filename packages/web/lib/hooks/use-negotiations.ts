import { api } from "@/lib/api/client";
import { useEntityQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useEntityQuery({
    id,
    queryKey: queryKeys.negotiations.detail,
    disabledKey: queryKeys.negotiations.all,
    fetch: api.negotiations.get,
  });
}
