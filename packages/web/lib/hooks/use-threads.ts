import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useThreads() {
  return useQuery({
    queryKey: queryKeys.threads.list(),
    queryFn: ({ signal }) => api.threads.list({ signal }),
    enabled: isApiConfigured,
  });
}

export function useThread(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.threads.detail(id) : queryKeys.threads.all,
    queryFn: ({ signal }) => api.threads.get(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
