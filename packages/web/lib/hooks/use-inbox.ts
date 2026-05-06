"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import type { InboxItem } from "@/lib/types/inbox";
import { queryKeys } from "./keys";

/**
 * Things the human owes a decision on — tasks awaiting their review,
 * tasks of theirs that hit a wall, escalations involving their agents.
 * Backs the Home sidebar's primary list.
 */
export function useInbox() {
  return useQuery<InboxItem[]>({
    queryKey: queryKeys.inbox.list(),
    queryFn: ({ signal }) => api.inbox.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });
}
