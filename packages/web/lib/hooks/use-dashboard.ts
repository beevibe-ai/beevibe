import { api } from "@/lib/api/client";
import { summaryToDisplay } from "@/lib/dashboard-display";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useDashboard() {
  return useCollectionQuery({
    queryKey: queryKeys.dashboard.summary(),
    fetch: api.dashboard.summary,
    select: summaryToDisplay,
  });
}
