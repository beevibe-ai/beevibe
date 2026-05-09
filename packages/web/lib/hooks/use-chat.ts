"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

const SID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function mintSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += SID_ALPHABET[b % SID_ALPHABET.length];
  return `sess_${suffix}`;
}

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
 * Fresh conversations get their own cache slot so a draft in flight
 * doesn't pollute the loaded "latest" conversation, and vice versa.
 */
const FRESH_CACHE_ID = "__draft__";

/** Empty response shape used to seed a fresh-cache entry. */
const FRESH_HISTORY: ChatHistoryResponse = {
  ok: true,
  agent: null,
  messages: [],
  prior_session_id: null,
  conversation_id: null,
};

/**
 * Conversation state for the chat surface, as a thin layer over React
 * Query. The cache slot keyed by `conversationId` (or `__draft__` for
 * fresh) is the single source of truth — sends mutate it via
 * `setQueryData`, and `prior_session_id` is read straight off the cached
 * response. No component-state copies of messages or chain pointers.
 */
export function useChat(opts: UseChatOptions = {}) {
  const { conversationId, fresh } = opts;
  const queryClient = useQueryClient();

  const cacheId = fresh ? FRESH_CACHE_ID : conversationId;
  const queryKey = queryKeys.chat.history(cacheId);

  const history = useQuery<ChatHistoryResponse>({
    queryKey,
    queryFn: ({ signal }) => api.chat.history({ conversationId, signal }),
    // Fresh surface has no server-side chain to fetch; the cache slot
    // accumulates locally via mutation `setQueryData` below.
    enabled: isApiConfigured && !fresh,
    staleTime: Infinity,
  });

  // Seed the fresh cache slot when entering a fresh surface so a stale
  // draft from a prior /chat?new=1 visit doesn't reappear. Depends on
  // primitives only — `queryKey` is a fresh array every render, which
  // would re-fire this effect and clobber optimistic updates.
  useEffect(() => {
    if (!fresh) return;
    queryClient.setQueryData<ChatHistoryResponse>(
      queryKeys.chat.history(FRESH_CACHE_ID),
      FRESH_HISTORY,
    );
    // Run on entry only — onMutate/onSuccess own the slot from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  const messages = useMemo<ChatMessage[]>(
    () => (history.data?.messages ?? []).map(fromHistory),
    [history.data],
  );

  // Derived from the cache, not duplicated in component state. Whoever
  // owns the cache (history fetch or our setQueryData calls) is also the
  // source of truth for what to chain onto next.
  const priorSessionId = history.data?.prior_session_id ?? undefined;

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
    onMutate: ({ message }) => {
      // Optimistically append the user's turn so it shows up instantly.
      queryClient.setQueryData<ChatHistoryResponse>(queryKey, (prev) => {
        const base = prev ?? FRESH_HISTORY;
        return {
          ...base,
          messages: [
            ...base.messages,
            { id: localId(), role: "user", content: message },
          ],
        };
      });
    },
    onSuccess: (data) => {
      // Append the agent turn and advance the chain pointer in-place.
      queryClient.setQueryData<ChatHistoryResponse>(queryKey, (prev) => {
        const base = prev ?? FRESH_HISTORY;
        const agentMessage: ChatHistoryMessage = {
          id: `a_${data.session_id}`,
          role: "agent",
          content: data.response,
          session_id: data.session_id,
          ...(data.view_refs ? { view_refs: data.view_refs } : {}),
          ...(data.open_view ? { open_view: data.open_view } : {}),
          ...(data.suggested_actions ? { suggested_actions: data.suggested_actions } : {}),
        };
        return {
          ...base,
          messages: [...base.messages, agentMessage],
          prior_session_id: data.session_id,
        };
      });
      // First turn of a brand-new conversation can flip the server's
      // onboarding flag; refetch /me so the welcome wizard exits.
      if (priorSessionId === undefined) {
        queryClient.invalidateQueries({ queryKey: queryKeys.me.all });
      }
      // Conversation list (sidebar) needs to see the new chain.
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations() });
      // The "latest" conversation slot may now be stale — when the chat
      // surface drops the `?new=1` param it'll refetch and land on the
      // chain we just created.
      queryClient.invalidateQueries({
        queryKey: queryKeys.chat.history(undefined),
      });
    },
    onError: () => {
      // Roll back the optimistic user turn so the input doesn't look
      // sent-and-stuck.
      queryClient.setQueryData<ChatHistoryResponse>(queryKey, (prev) => {
        if (!prev) return prev;
        const last = prev.messages[prev.messages.length - 1];
        if (last?.role !== "user") return prev;
        return { ...prev, messages: prev.messages.slice(0, -1) };
      });
    },
  });

  const send = useCallback(
    (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || mutation.isPending) return;
      mutation.mutate({ message: trimmed, sessionId: mintSessionId() });
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
