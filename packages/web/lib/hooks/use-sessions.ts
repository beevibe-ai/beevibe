import { api } from "@/lib/api/client";
import { useDetailQuery } from "./detail-query";
import { queryKeys } from "./keys";

export function useSession(shortId: string | undefined) {
  return useDetailQuery({
    id: shortId,
    key: queryKeys.sessions.detail,
    fallbackKey: queryKeys.sessions.all,
    fetch: api.sessions.get,
  });
}

/**
 * Whole chat conversation for the session detail page — every chained
 * turn sharing the addressed session's `conversation_id`. Non-chat
 * sessions resolve to a single-turn conversation, so the detail page
 * renders them unchanged.
 */
export function useConversation(shortId: string | undefined) {
  return useDetailQuery({
    id: shortId,
    key: queryKeys.sessions.conversation,
    fallbackKey: queryKeys.sessions.all,
    fetch: api.sessions.conversation,
    // A completed turn's transcript is immutable, so this potentially-large
    // fetch (every turn × up to 500 events) needn't refetch on focus/idle.
    // In-flight turns surface live via SSE, not this query. Cold loads still
    // refetch on mount.
    staleTime: 60_000,
  });
}
