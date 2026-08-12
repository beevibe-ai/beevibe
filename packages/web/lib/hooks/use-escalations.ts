import { api } from "@/lib/api/client";
import { useApiDetailQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useApiDetailQuery({
    id,
    keyFor: queryKeys.escalations.detail,
    fallbackKey: queryKeys.escalations.all,
    fetch: (escalationId, ctx) => api.escalations.get(escalationId, ctx),
  });
}
