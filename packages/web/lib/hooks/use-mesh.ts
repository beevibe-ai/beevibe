import { api } from "@/lib/api/client";
import { overviewToDisplay } from "@/lib/mesh-display";
import type { MeshWindow } from "@/lib/types/mesh";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useMeshOverview(filter: { window?: MeshWindow } = {}) {
  return useApiQuery(
    queryKeys.mesh.overview(filter),
    ({ signal }) => api.mesh.overview(filter, { signal }),
    { select: overviewToDisplay },
  );
}
