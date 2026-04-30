import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function usePromotions() {
  return useQuery({
    queryKey: queryKeys.promotions.list(),
    queryFn: ({ signal }) => api.promotions.list({ signal }),
    enabled: isApiConfigured,
  });
}
