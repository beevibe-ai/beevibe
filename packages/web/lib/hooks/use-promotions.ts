import { api } from "@/lib/api/client";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function usePromotions() {
  return useApiQuery(queryKeys.promotions.list(), ({ signal }) =>
    api.promotions.list({ signal }),
  );
}
