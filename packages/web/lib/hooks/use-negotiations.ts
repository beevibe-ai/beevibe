import { api } from "@/lib/api/client";
import { useEntityQuery } from "./use-entity";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useEntityQuery(
    id,
    queryKeys.negotiations.detail,
    queryKeys.negotiations.all,
    api.negotiations.get,
  );
}
