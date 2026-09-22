"use client";

import { api } from "@/lib/api/client";
import type { InboxItem } from "@/lib/types/inbox";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

/**
 * Things the human owes a decision on — tasks awaiting their review,
 * tasks of theirs that hit a wall, escalations involving their agents.
 * Backs the Home sidebar's primary list.
 */
export function useInbox() {
  return useApiQuery<InboxItem[]>(
    queryKeys.inbox.list(),
    ({ signal }) => api.inbox.list({ signal }),
    { staleTime: 10_000 },
  );
}
