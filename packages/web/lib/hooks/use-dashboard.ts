import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: ({ signal }) => api.dashboard.summary({ signal }),
    enabled: isApiConfigured,
  });
}
