"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ChatTurnResponse } from "@/lib/api/client";
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

/**
 * Local-state chat history — no React Query cache for the conversation
 * itself (each turn is a fresh DB session row anyway). The mutation runs
 * the turn; on success we append the agent's response.
 *
 * Continuity across turns is via `prior_session_id` — we send the latest
 * agent session id with each user message, and the runtime spawns with
 * `--resume` so the agent has the full conversation history.
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [priorSessionId, setPriorSessionId] = useState<string | undefined>();
  const [pendingSessionId, setPendingSessionId] = useState<string | undefined>();
  const queryClient = useQueryClient();

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
      setMessages((prev) => [
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
      setPriorSessionId(data.session_id);
      setPendingSessionId(undefined);
      // The agent likely minted/updated tasks during this turn — force a
      // fresh fetch even though SSE will also fire `task.updated`.
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
    onError: () => {
      setPendingSessionId(undefined);
    },
  });

  const send = useCallback(
    (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || mutation.isPending) return;
      const sessionId = mintSessionId();
      setMessages((prev) => [...prev, { id: localId(), role: "user", content: trimmed }]);
      setPendingSessionId(sessionId);
      mutation.mutate({ message: trimmed, sessionId });
    },
    [mutation],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setPriorSessionId(undefined);
    setPendingSessionId(undefined);
    mutation.reset();
  }, [mutation]);

  return {
    messages,
    send,
    reset,
    isPending: mutation.isPending,
    error: mutation.error,
    /** Session id of the in-flight turn — for the chat UI's step subscription. */
    pendingSessionId,
  };
}
