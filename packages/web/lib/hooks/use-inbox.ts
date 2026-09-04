"use client";

import { api } from "@/lib/api/client";
import type { InboxItem } from "@/lib/types/inbox";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

/**
 * Things the human owes a decision on — tasks awaiting their review,
 * tasks of theirs that hit a wall, escalations involving their agents.
 * Backs the Home sidebar's primary list.
 */
export function useInbox() {
  return useCollectionQuery<InboxItem[]>({
    queryKey: queryKeys.inbox.list(),
    fetch: api.inbox.list,
    staleTime: 10_000,
  });
}
