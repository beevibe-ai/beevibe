import { api } from "@/lib/api/client";
import { overviewToDisplay } from "@/lib/mesh-display";
import type { MeshWindow } from "@/lib/types/mesh";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useMeshOverview(filter: { window?: MeshWindow } = {}) {
  return useCollectionQuery({
    queryKey: queryKeys.mesh.overview(filter),
    fetch: (opts) => api.mesh.overview(filter, opts),
    select: overviewToDisplay,
  });
}
