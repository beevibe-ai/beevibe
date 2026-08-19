import { api } from "@/lib/api/client";
import { useDetailQuery } from "./detail-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useDetailQuery(
    id,
    queryKeys.negotiations.detail,
    queryKeys.negotiations.all,
    api.negotiations.get,
  );
}
