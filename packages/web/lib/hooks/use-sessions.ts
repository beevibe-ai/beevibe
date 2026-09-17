import { api } from "@/lib/api/client";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

export function useSession(shortId: string | undefined) {
  return useDetailQuery(shortId, queryKeys.sessions, (sid, opts) =>
    api.sessions.get(sid, opts),
  );
}

/**
 * Whole chat conversation for the session detail page — every chained
 * turn sharing the addressed session's `conversation_id`. Non-chat
 * sessions resolve to a single-turn conversation, so the detail page
 * renders them unchanged.
 *
 * Same id-keyed shape as `useSession`, under the `conversation` key slot
 * rather than `detail` — hence the key pair spelled out here instead of
 * passing the `queryKeys.sessions` group whole.
 */
export function useConversation(shortId: string | undefined) {
  return useDetailQuery(
    shortId,
    { all: queryKeys.sessions.all, detail: queryKeys.sessions.conversation },
    (sid, opts) => api.sessions.conversation(sid, opts),
    {
      // A completed turn's transcript is immutable, so this potentially-large
      // fetch (every turn × up to 500 events) needn't refetch on focus/idle.
      // In-flight turns surface live via SSE, not this query. Cold loads still
      // refetch on mount.
      staleTime: 60_000,
    },
  );
}
