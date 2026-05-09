"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Import from the narrow `./domain` subpath to avoid pulling in
// `@beevibe/core/auth` (which uses `node:crypto` for daemon-token
// hashing — incompatible with browser bundling).
import { sessionId } from "@beevibe/core/domain";
import {
  api,
  type ChatHistoryMessage,
  type ChatHistoryResponse,
  type ChatTurnResponse,
  type SuggestedAction,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

export interface ChatMessage {
  /** Stable key for React; not persisted. */
  id: string;
  role: "user" | "agent";
  content: string;
  /** Set on agent messages so the UI can link to the session detail page. */
  session_id?: string;
  /** Entity ids the agent referenced — rendered as inline cards. */
  view_refs?: string[];
  /** Resolved `<open_view>` directive — rendered as an "Open this →" CTA. */
  open_view?: { path: string; label?: string };
  /** Resolved `<suggest_action>` chips — chip shows label, clicking sends prompt (or label). */
  suggested_actions?: SuggestedAction[];
}

let nextLocalId = 0;
const localId = (): string => `m_${++nextLocalId}`;

// Client mints the session id so it can subscribe to `session.step` SSE
// events for this turn BEFORE the server starts the run. Uses the same
// nanoid-backed helper the server uses (uniform distribution by
// construction, no modulo bias).

function fromHistory(m: ChatHistoryMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.session_id ? { session_id: m.session_id } : {}),
    ...(m.view_refs ? { view_refs: m.view_refs } : {}),
    ...(m.open_view ? { open_view: m.open_view } : {}),
    ...(m.suggested_actions ? { suggested_actions: m.suggested_actions } : {}),
  };
}

export interface UseChatOptions {
  /**
   * Conversation head id (full `sess_xxx`). When set, GET /chat returns
   * only that conversation's chain. When unset, the most recent
   * conversation loads (default behavior).
   */
  conversationId?: string;
  /**
   * Render the surface as if it were a brand-new conversation: skip
   * showing prior history (even though it's still cached) and break the
   * `prior_session_id` chain. Flips off automatically once the user
   * sends their first message — that turn becomes the new chain head.
   */
  fresh?: boolean;
}

/**
 * Conversation state for the chat surface.
 *
 * Hydrates from `GET /chat` on mount so a reload doesn't lose the
 * conversation. Sessions are persisted server-side (the `session`
 * table) and reconstructed as messages by the route handler. When
 * `conversationId` is set, only that conversation's chain is fetched.
 *
 * Cache invalidation for tasks/dashboard/sessions rides the SSE channel
 * via `useLiveUpdates` — no explicit refetch from this hook.
 */
export function useChat(opts: UseChatOptions = {}) {
  const { conversationId, fresh } = opts;
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [priorSessionId, setPriorSessionId] = useState<string | undefined>();
  const queryClient = useQueryClient();

  const history = useQuery<ChatHistoryResponse>({
    queryKey: queryKeys.chat.history(conversationId),
    queryFn: ({ signal }) => api.chat.history({ conversationId, signal }),
    // When `fresh` is set we still want the cache populated so a future
    // navigation to /chat (without ?new) shows the prior conversation —
    // but we don't need the round-trip RIGHT NOW for the empty surface.
    enabled: isApiConfigured && !fresh,
    staleTime: Infinity,
  });

  // Initialize prior_session_id from history once it lands. If the user
  // sends a new turn, that takes over (setPriorSessionId in onSuccess);
  // we only seed once per history load. Re-seeds when the conversation
  // changes (key includes conversationId).
  const seededFor = useRef<string | undefined>(undefined);
  const seedKeyForConversation = `${conversationId ?? "<latest>"}::${
    history.data?.prior_session_id ?? "<empty>"
  }`;
  useEffect(() => {
    if (fresh) return;
    const data = history.data;
    if (!data) return;
    if (seededFor.current === seedKeyForConversation) return;
    seededFor.current = seedKeyForConversation;
    setPriorSessionId(data.prior_session_id ?? undefined);
  }, [history.data, fresh, seedKeyForConversation]);

  const mutation = useMutation<
    ChatTurnResponse,
    Error,
    { message: string; sessionId: string }
  >({
    mutationFn: ({ message, sessionId }) =>
      api.chat.send({
        message,
        session_id: sessionId,
        prior_session_id: priorSessionId,
      }),
    onSuccess: (data) => {
      setLocalMessages((prev) => [
        ...prev,
        {
          id: localId(),
          role: "agent",
          content: data.response,
          session_id: data.session_id,
          view_refs: data.view_refs,
          ...(data.open_view ? { open_view: data.open_view } : {}),
          ...(data.suggested_actions ? { suggested_actions: data.suggested_actions } : {}),
        },
      ]);
      // Only the first turn of a conversation can flip the server's
      // onboarding flag — refetch /me so the welcome wizard exits
      // automatically. Subsequent turns can't change onboarding state, so
      // we skip the invalidation entirely.
      if (priorSessionId === undefined) {
        queryClient.invalidateQueries({ queryKey: queryKeys.me.all });
      }
      setPriorSessionId(data.session_id);
      // A new turn on this surface invalidates the conversation list so
      // sidebars / pickers see the new conversation immediately.
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations() });
    },
  });

  // Concatenate history + local turns. When `fresh`, we drop history
  // entirely until the user sends their first message — then localMessages
  // takes over and the conversation list refetches to show the new chain.
  const messages = useMemo<ChatMessage[]>(() => {
    if (fresh) return localMessages;
    const seed = history.data?.messages ?? [];
    return [...seed.map(fromHistory), ...localMessages];
  }, [history.data, localMessages, fresh]);

  const send = useCallback(
    (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || mutation.isPending) return;
      const sid = sessionId();
      setLocalMessages((prev) => [...prev, { id: localId(), role: "user", content: trimmed }]);
      mutation.mutate({ message: trimmed, sessionId: sid });
    },
    [mutation],
  );

  return {
    messages,
    send,
    isPending: mutation.isPending,
    error: mutation.error,
    /**
     * Session id of the in-flight turn — derived from the mutation's input
     * variables while pending so the chat UI can subscribe to `session.step`
     * SSE events for this turn.
     */
    pendingSessionId: mutation.isPending ? mutation.variables?.sessionId : undefined,
    /** History query state, for showing a "loading prior conversation…" indicator. */
    isLoadingHistory: history.isLoading,
  };
}
