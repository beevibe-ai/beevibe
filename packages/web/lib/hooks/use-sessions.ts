import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export function useSession(shortId: string | undefined) {
  return useQuery({
    queryKey: shortId ? queryKeys.sessions.detail(shortId) : queryKeys.sessions.all,
    queryFn: ({ signal }) => api.sessions.get(shortId as string, { signal }),
    enabled: isApiConfigured && !!shortId,
  });
}

/**
 * Whole chat conversation for the session detail page — every chained
 * turn sharing the addressed session's `conversation_id`. Non-chat
 * sessions resolve to a single-turn conversation, so the detail page
 * renders them unchanged.
 */
export function useConversation(shortId: string | undefined) {
  return useQuery({
    queryKey: shortId
      ? queryKeys.sessions.conversation(shortId)
      : queryKeys.sessions.all,
    queryFn: ({ signal }) => api.sessions.conversation(shortId as string, { signal }),
    enabled: isApiConfigured && !!shortId,
  });
}
