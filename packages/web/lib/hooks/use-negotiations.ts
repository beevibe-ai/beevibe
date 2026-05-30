import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useNegotiation(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.negotiations.detail(id) : queryKeys.negotiations.all,
    queryFn: ({ signal }) => api.negotiations.get(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
