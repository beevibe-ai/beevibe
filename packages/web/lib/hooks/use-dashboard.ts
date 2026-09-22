import { api } from "@/lib/api/client";
import { summaryToDisplay } from "@/lib/dashboard-display";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useDashboard() {
  return useApiQuery(
    queryKeys.dashboard.summary(),
    ({ signal }) => api.dashboard.summary({ signal }),
    { select: summaryToDisplay },
  );
}
