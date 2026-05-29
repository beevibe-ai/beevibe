import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useEscalation(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.escalations.detail(id) : queryKeys.escalations.all,
    queryFn: ({ signal }) => api.escalations.get(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
