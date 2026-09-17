import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useEscalation(id: string | undefined) {
  return useDetailQuery(id, queryKeys.escalations, (escalationId, opts) =>
    api.escalations.get(escalationId, opts),
  );
}
