"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type ChatConversationsResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

/**
 * The caller's chat conversations, newest first.
 *
 * The chat landing surface and the conversation sidebar had byte-identical
 * copies of this query. They mount together on /chat, so the two were
 * always describing one cache entry twice.
 */
export function useConversations() {
  return useQuery<ChatConversationsResponse>({
    queryKey: queryKeys.chat.conversations(),
    queryFn: ({ signal }) => api.chat.conversations({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });
}
