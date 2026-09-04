import { api } from "@/lib/api/client";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function usePromotions() {
  return useCollectionQuery({
    queryKey: queryKeys.promotions.list(),
    fetch: api.promotions.list,
  });
}
