import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { detailQueryOptions } from "./detail-query";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useQuery(detailQueryOptions(queryKeys.escalations, api.escalations.get, id));
}
