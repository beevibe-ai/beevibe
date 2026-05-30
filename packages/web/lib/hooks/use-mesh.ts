import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { overviewToDisplay } from "@/lib/mesh-display";
import type { MeshWindow } from "@/lib/types/mesh";
import { queryKeys } from "./keys";

export function useMeshOverview(filter: { window?: MeshWindow } = {}) {
  return useQuery({
    queryKey: queryKeys.mesh.overview(filter),
    queryFn: ({ signal }) => api.mesh.overview(filter, { signal }),
    select: overviewToDisplay,
    enabled: isApiConfigured,
  });
}
