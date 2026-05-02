"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ChatHistoryMessage,
  type ChatHistoryResponse,
  type ChatTurnResponse,
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
}

let nextLocalId = 0;
const localId = (): string => `m_${++nextLocalId}`;

const SID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Mint a session id matching core's `sessionId()` format
 * (`sess_<12 chars from [0-9A-Za-z]>`). Generated client-side per turn so
 * the chat UI can subscribe to `session.step` SSE events for this id
 * BEFORE the server starts the run.
 */
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
  };
}

/**
 * Conversation state for the chat surface.
 *
 * Hydrates from `GET /chat` on mount so a reload doesn't lose the
 * conversation — sessions are persisted server-side (the `session`
 * table) and reconstructed as messages by the route handler. New turns
 * append to local state and chain `prior_session_id` to whatever the
 * latest session id is (history's last, or the most recent mutation's
 * response).
 *
 * Cache invalidation for tasks/dashboard/sessions rides the SSE channel
 * via `useLiveUpdates` — no explicit refetch from this hook.
 */
export function useChat() {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [priorSessionId, setPriorSessionId] = useState<string | undefined>();
  const queryClient = useQueryClient();

  const history = useQuery<ChatHistoryResponse>({
    queryKey: queryKeys.chat.history(),
    queryFn: ({ signal }) => api.chat.history({ signal }),
    enabled: isApiConfigured,
    staleTime: Infinity, // refetch only on explicit invalidation (e.g. reset)
  });

  // Initialize prior_session_id from history once it lands. If the user
  // sends a new turn, that takes over (setPriorSessionId in onSuccess);
  // we only seed once per history load.
  const seededFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const data = history.data;
    if (!data) return;
    const seedKey = data.prior_session_id ?? "<empty>";
    if (seededFor.current === seedKey) return;
    seededFor.current = seedKey;
    setPriorSessionId(data.prior_session_id ?? undefined);
  }, [history.data]);

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
    },
  });

  // Concatenate history (server-truth, oldest first) + locally-appended
  // turns from this mount. The two sets never overlap by construction:
  // history is everything BEFORE this mount; localMessages is everything
  // ADDED by this mount's mutations.
  const messages = useMemo<ChatMessage[]>(() => {
    const seed = history.data?.messages ?? [];
    return [...seed.map(fromHistory), ...localMessages];
  }, [history.data, localMessages]);

  const send = useCallback(
    (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || mutation.isPending) return;
      const sessionId = mintSessionId();
      setLocalMessages((prev) => [...prev, { id: localId(), role: "user", content: trimmed }]);
      mutation.mutate({ message: trimmed, sessionId });
    },
    [mutation],
  );

  const reset = useCallback(() => {
    setLocalMessages([]);
    setPriorSessionId(undefined);
    seededFor.current = undefined;
    mutation.reset();
    // Drop the cached history so the next mount fetches fresh — and so
    // the current view becomes empty immediately rather than re-showing
    // the last conversation.
    queryClient.setQueryData(queryKeys.chat.history(), {
      ok: true,
      agent: history.data?.agent ?? null,
      messages: [],
      prior_session_id: null,
    } satisfies ChatHistoryResponse);
  }, [mutation, queryClient, history.data?.agent]);

  return {
    messages,
    send,
    reset,
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
