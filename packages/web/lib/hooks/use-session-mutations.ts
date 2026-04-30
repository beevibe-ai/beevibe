import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";

export function useCancelSession(shortId: string, taskId?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.sessions.cancel(shortId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.sessions.detail(shortId) });
      client.invalidateQueries({ queryKey: queryKeys.sessions.all });
      if (taskId) client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      client.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}
