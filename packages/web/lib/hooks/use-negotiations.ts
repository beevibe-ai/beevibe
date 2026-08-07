import { api } from "@/lib/api/client";
import { useDetailQuery } from "./detail-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useDetailQuery({
    id,
    key: queryKeys.negotiations.detail,
    fallbackKey: queryKeys.negotiations.all,
    fetch: api.negotiations.get,
  });
}
