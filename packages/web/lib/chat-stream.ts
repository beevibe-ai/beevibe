"use client";

import { useCallback, useState } from "react";
import { useSseEvents, type BvEvent } from "./sse";

export interface ChatStreamStep {
  event_id: string;
  kind: "tool_call" | "tool_result" | "agent" | "summary";
  tool_name?: string;
  /** Server truncates to 512 chars in the trigger payload. */
  content: string;
  received_at: number;
}

function parseStep(ev: BvEvent): ChatStreamStep | undefined {
  if (ev.event !== "session.step" || !ev.data) return undefined;
  const d = ev.data;
  const kind = typeof d.kind === "string" ? d.kind : undefined;
  if (kind !== "tool_call" && kind !== "tool_result" && kind !== "agent" && kind !== "summary") {
    return undefined;
  }
  return {
    event_id: typeof d.event_id === "string" ? d.event_id : `${ev.id}-${Date.now()}`,
    kind,
    tool_name: typeof d.tool_name === "string" ? d.tool_name : undefined,
    content: typeof d.content === "string" ? d.content : "",
    received_at: Date.now(),
  };
}

/**
 * Stream of `session.step` events scoped to one session id. Returns the
 * accumulated step list (new chat turn → fresh array, since the new
 * sessionId triggers a new state slot via React's per-render closure).
 */
export function useChatStream(sessionId: string | undefined): ChatStreamStep[] {
  // Keying state by sessionId means each turn gets its own fresh `steps`
  // array — no separate reset effect to race with the resubscription.
  const [stepsBySession, setStepsBySession] = useState<Record<string, ChatStreamStep[]>>({});

  const onEvent = useCallback(
    (ev: BvEvent) => {
      if (!sessionId || ev.id !== sessionId) return;
      const step = parseStep(ev);
      if (!step) return;
      setStepsBySession((prev) => {
        const cur = prev[sessionId] ?? [];
        if (cur.some((s) => s.event_id === step.event_id)) return prev;
        return { ...prev, [sessionId]: [...cur, step] };
      });
    },
    [sessionId],
  );
  useSseEvents(onEvent);

  return sessionId ? stepsBySession[sessionId] ?? EMPTY : EMPTY;
}

const EMPTY: ChatStreamStep[] = [];
