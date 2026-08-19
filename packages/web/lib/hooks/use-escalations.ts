import { api } from "@/lib/api/client";
import { useDetailQuery } from "./detail-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useDetailQuery(
    id,
    queryKeys.escalations.detail,
    queryKeys.escalations.all,
    api.escalations.get,
  );
}
