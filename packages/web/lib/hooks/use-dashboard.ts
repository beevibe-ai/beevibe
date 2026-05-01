import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { summaryToDisplay } from "@/lib/dashboard-display";
import { queryKeys } from "./keys";

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: ({ signal }) => api.dashboard.summary({ signal }),
    select: summaryToDisplay,
    enabled: isApiConfigured,
  });
}
