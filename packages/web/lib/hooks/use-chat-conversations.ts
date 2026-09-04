"use client";

import { api, type ChatConversationsResponse } from "@/lib/api/client";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

/**
 * The caller's recent chat conversations, backing both the chat
 * landing page's "recent" strip and the conversation sidebar. Those two
 * had each declared the same query — same key, same fetch, same
 * `staleTime` — so a change to one silently disagreed with the other
 * while sharing a cache slot.
 */
export function useChatConversations() {
  return useCollectionQuery<ChatConversationsResponse>({
    queryKey: queryKeys.chat.conversations(),
    fetch: api.chat.conversations,
    staleTime: 30_000,
  });
}
