"use client";

import { api, type WorkProductDetail } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useWorkProduct(workProductId: string | undefined) {
  return useDetailQuery<WorkProductDetail>(
    workProductId,
    queryKeys.workProducts,
    (id, opts) => api.workProducts.get(id, opts),
    { staleTime: 30_000 },
  );
}
