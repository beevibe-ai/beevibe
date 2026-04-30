import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useMeshOverview(filter: { since?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.mesh.overview(filter),
    queryFn: ({ signal }) => api.mesh.overview(filter, { signal }),
    enabled: isApiConfigured,
  });
}
