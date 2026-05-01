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
}

let nextLocalId = 0;
const localId = (): string => `m_${++nextLocalId}`;

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
  const queryClient = useQueryClient();

  const mutation = useMutation<ChatTurnResponse, Error, string>({
    mutationFn: (message) => api.chat.send({ message, prior_session_id: priorSessionId }),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: localId(),
          role: "agent",
          content: data.response,
          session_id: data.session_id,
        },
      ]);
      setPriorSessionId(data.session_id);
      // The agent likely minted/updated tasks during this turn — force a
      // fresh fetch even though SSE will also fire `task.updated`.
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
  });

  const send = useCallback(
    (rawMessage: string) => {
      const trimmed = rawMessage.trim();
      if (!trimmed || mutation.isPending) return;
      setMessages((prev) => [...prev, { id: localId(), role: "user", content: trimmed }]);
      mutation.mutate(trimmed);
    },
    [mutation],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setPriorSessionId(undefined);
    mutation.reset();
  }, [mutation]);

  return {
    messages,
    send,
    reset,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
