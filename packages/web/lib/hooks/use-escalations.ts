import { api } from "@/lib/api/client";
import { useEntityQuery } from "./use-entity";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useEntityQuery(
    id,
    queryKeys.escalations.detail,
    queryKeys.escalations.all,
    api.escalations.get,
  );
}
