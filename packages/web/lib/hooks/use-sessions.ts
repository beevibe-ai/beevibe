import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { detailQueryOptions } from "./detail-query";
import { queryKeys } from "./keys";

export function useSession(shortId: string | undefined) {
  return useQuery(detailQueryOptions(queryKeys.sessions, api.sessions.get, shortId));
}

/**
 * Whole chat conversation for the session detail page — every chained
 * turn sharing the addressed session's `conversation_id`. Non-chat
 * sessions resolve to a single-turn conversation, so the detail page
 * renders them unchanged.
 */
export function useConversation(shortId: string | undefined) {
  return useQuery({
    ...detailQueryOptions(
      // Same fallback key as `useSession`, but the loaded key is the
      // conversation slot — the two coexist for one short id.
      { all: queryKeys.sessions.all, detail: queryKeys.sessions.conversation },
      api.sessions.conversation,
      shortId,
    ),
    // A completed turn's transcript is immutable, so this potentially-large
    // fetch (every turn × up to 500 events) needn't refetch on focus/idle.
    // In-flight turns surface live via SSE, not this query. Cold loads still
    // refetch on mount.
    staleTime: 60_000,
  });
}
