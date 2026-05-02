"use client";

import { useCallback, useEffect, useState } from "react";
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
 * accumulated step list; resets when `sessionId` changes (new chat turn).
 */
export function useChatStream(sessionId: string | undefined): ChatStreamStep[] {
  const [steps, setSteps] = useState<ChatStreamStep[]>([]);

  // Reset when session id changes — each new turn starts fresh.
  useEffect(() => {
    setSteps([]);
  }, [sessionId]);

  const onEvent = useCallback(
    (ev: BvEvent) => {
      if (!sessionId || ev.id !== sessionId) return;
      const step = parseStep(ev);
      if (!step) return;
      setSteps((prev) => {
        // De-dup if a step's event_id arrives twice (rare but possible on
        // EventSource reconnects).
        if (prev.some((s) => s.event_id === step.event_id)) return prev;
        return [...prev, step];
      });
    },
    [sessionId],
  );
  useSseEvents(onEvent);

  return steps;
}
