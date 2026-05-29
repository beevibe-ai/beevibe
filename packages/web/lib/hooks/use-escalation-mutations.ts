import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type EscalationResolveInput } from "@/lib/api/client";
import { queryKeys } from "./keys";

export function useResolveEscalation(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EscalationResolveInput) => api.escalations.resolve(id, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.escalations.detail(id) });
      // Resolving flips the escalation out of `pending`, which is the entire
      // population of the inbox's escalation branch, and re-queues both
      // sides' tasks (dashboard counts shift).
      client.invalidateQueries({ queryKey: queryKeys.inbox.all });
      client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}
