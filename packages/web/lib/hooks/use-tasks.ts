import { useQuery } from "@tanstack/react-query";
import { api, type TaskListFilter } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useTasks(filter: TaskListFilter = {}) {
  return useQuery({
    queryKey: queryKeys.tasks.list(filter),
    queryFn: ({ signal }) => api.tasks.list(filter, { signal }),
    enabled: isApiConfigured,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.tasks.detail(id) : queryKeys.tasks.all,
    queryFn: ({ signal }) => api.tasks.get(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
