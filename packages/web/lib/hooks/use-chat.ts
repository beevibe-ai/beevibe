"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ChatHistoryMessage,
  type ChatHistoryResponse,
  type ChatTurnResponse,
  type SuggestedAction,
} from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { ApiError } from "@/lib/api/http";
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
  //
  // `freshSeeded` flips to true once the seed has run for the current
  // fresh entry. The `messages` memo below uses it to suppress stale
  // cache reads on the FIRST render of a fresh surface (see comment
  // there for the cleanup-effect-strips-`new=1` symptom this prevents).
  const [freshSeeded, setFreshSeeded] = useState(false);
  useEffect(() => {
    if (!fresh) {
      setFreshSeeded(false);
      return;
    }
    queryClient.setQueryData<ChatHistoryResponse>(
      queryKeys.chat.history(FRESH_CACHE_ID),
      FRESH_HISTORY,
    );
    setFreshSeeded(true);
    // Run on entry only — onMutate/onSuccess own the slot from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  // First render of a fresh surface reads the cache *before* the seed
  // effect above has cleared it, so a draft left behind by a prior
  // /chat?new=1 visit would appear here as `messages.length > 0`.
  // ChatClient's cleanup useEffect interprets that as "user has sent
  // something on this fresh surface" and immediately strips `?new=1`
  // from the URL — first click looks like a no-op, second click works.
  // Suppress the stale read until the seed has fired this entry.
  const messages = useMemo<ChatMessage[]>(
    () => (fresh && !freshSeeded ? [] : (history.data?.messages ?? []).map(fromHistory)),
    [fresh, freshSeeded, history.data],
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
    onMutate: ({ message, sessionId }) => {
      // Optimistically append the user's turn AND stamp in_flight_session_id
      // into the cache so the thinking indicator survives nav-away-and-back:
      // if the hook unmounts mid-mutation, local `mutation.isPending` state
      // is gone, and `serverInFlightSessionId` is the only signal left for
      // the next mount to honor.
      queryClient.setQueryData<ChatHistoryResponse>(queryKey, (prev) => {
        const base = prev ?? FRESH_HISTORY;
        return {
          ...base,
          messages: [
            ...base.messages,
            { id: localId(), role: "user", content: message },
          ],
          in_flight_session_id: sessionId,
        };
      });
    },
    onSuccess: (data) => {
      // Append the agent turn, advance the chain pointer, AND clear
      // in_flight_session_id. Without the explicit clear the thinking
      // indicator persists (the spread preserves whatever onMutate
      // stamped) — manifesting as "agent replied but UI still spinning."
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
          in_flight_session_id: undefined,
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
    onError: (err) => {
      // agent_offline (503) is special: the api persisted the session row
      // before rejecting, so the turn is queued, not lost. Keep the user
      // message AND in_flight_session_id visible — refresh would show
      // them anyway from the server, and rolling back here creates a
      // flicker of "vanished, then back on refresh". When the daemon
      // reconnects and the session completes, session.updated SSE
      // invalidates chat queries and the response auto-appears.
      if (err instanceof ApiError && err.errorCode === "agent_offline") return;

      // Other errors (429 rate limit, 400 validation, etc.) reject the
      // turn before persistence — roll back the optimistic user message
      // AND clear in_flight_session_id so the input doesn't look
      // sent-and-stuck.
      queryClient.setQueryData<ChatHistoryResponse>(queryKey, (prev) => {
        if (!prev) return prev;
        const last = prev.messages[prev.messages.length - 1];
        const messages =
          last?.role === "user" ? prev.messages.slice(0, -1) : prev.messages;
        return { ...prev, messages, in_flight_session_id: undefined };
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

  // Clear the prior turn's error banner once the auto-recovery path
  // settles: when SSE invalidation fans an agent reply into the cache
  // (the queued session finally completed), `messages.at(-1)` flips to
  // an "agent" role. Without this reset, the chat UI shows the new
  // reply AND a stale "Couldn't reach the agent" banner side-by-side.
  const lastRole = messages.at(-1)?.role;
  const { isError: mutationIsError, reset: resetMutation } = mutation;
  useEffect(() => {
    if (mutationIsError && lastRole === "agent") resetMutation();
  }, [mutationIsError, lastRole, resetMutation]);

  // The in-flight session id (drives the "agent thinking" indicator) has
  // two sources merged here, in precedence order:
  //   1. local mutation — freshest while the user's POST /chat is open.
  //   2. server history — set when the conversation's tail session is
  //      still in `pending`/`running` status. Survives navigation away,
  //      cross-tab opens, and cold refreshes; closes the gap left by
  //      the local-only mutation state.
  const localSendingSessionId = mutation.isPending ? mutation.variables?.sessionId : undefined;
  const serverInFlightSessionId = history.data?.in_flight_session_id;
  const inFlightSessionId = localSendingSessionId ?? serverInFlightSessionId;

  return {
    messages,
    send,
    /**
     * Narrow: this surface's own send is in flight. Use for the
     * textarea disable + fresh-redirect gate so users can keep
     * drafting while another tab's turn finishes.
     */
    isSubmitting: mutation.isPending,
    /**
     * Broad: any session for this conversation is in flight (this
     * surface or another tab). Use for the thinking indicator + send
     * button disable + suggestion suppression so the UI reflects
     * server reality, not just this tab's mutation.
     */
    isPending: mutation.isPending || serverInFlightSessionId !== undefined,
    error: mutation.error,
    /** Renamed from pendingSessionId — semantics unchanged at the call site. */
    pendingSessionId: inFlightSessionId,
    /** History query state, for showing a "loading prior conversation…" indicator. */
    isLoadingHistory: history.isLoading,
    /**
     * Set when the agent's currently-configured CLI differs from the CLI
     * this conversation is pinned to. UI surfaces a banner so the user
     * knows why their new runtime isn't being used here.
     */
    runtimeMismatch: history.data?.runtime_mismatch,
  };
}
