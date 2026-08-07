import { api } from "@/lib/api/client";
import { useDetailQuery } from "./detail-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useDetailQuery({
    id,
    key: queryKeys.escalations.detail,
    fallbackKey: queryKeys.escalations.all,
    fetch: api.escalations.get,
  });
}
