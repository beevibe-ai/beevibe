"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type ChatConversationsResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

/**
 * The caller's chat conversations, newest first — the recent-chats strip
 * on the chat landing view and the conversation sidebar's whole list.
 *
 * Both had an identical inline `useQuery` on
 * `queryKeys.chat.conversations()`. One definition means the next option
 * added to either is added to both, which is the part that kept drifting
 * on the other shared keys.
 */
export function useChatConversations() {
  return useQuery<ChatConversationsResponse>({
    queryKey: queryKeys.chat.conversations(),
    queryFn: ({ signal }) => api.chat.conversations({ signal }),
    enabled: isApiConfigured,
    staleTime: 30_000,
  });
}
