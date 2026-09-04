import { api } from "@/lib/api/client";
import { useEntityQuery } from "./entity-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useEntityQuery({
    id,
    queryKey: queryKeys.escalations.detail,
    disabledKey: queryKeys.escalations.all,
    fetch: api.escalations.get,
  });
}
