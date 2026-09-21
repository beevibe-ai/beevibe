import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { detailQueryOptions } from "./detail-query";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useQuery(detailQueryOptions(queryKeys.negotiations, api.negotiations.get, id));
}
