import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useThreads() {
  return useQuery({
    queryKey: queryKeys.threads.list(),
    queryFn: () => api.threads.list(),
    enabled: isApiConfigured,
  });
}

export function useThread(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.threads.detail(id) : queryKeys.threads.all,
    queryFn: () => api.threads.get(id as string),
    enabled: isApiConfigured && !!id,
  });
}
