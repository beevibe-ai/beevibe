import { api } from "@/lib/api/client";
import { useApiDetailQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useApiDetailQuery(id, queryKeys.escalations, (escalationId, opts) =>
    api.escalations.get(escalationId, opts),
  );
}
