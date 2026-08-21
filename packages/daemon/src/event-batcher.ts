/**
 * Batching writer for `/runtime/events`.
 *
 * Both dispatch paths — the CLI runtime in `spawner.ts` and the Docker
 * sandbox in `repo-runs.ts` — stream fine-grained steps that would
 * otherwise cost one POST per token. Each used to carry its own copy of
 * the same buffer/timer/threshold trio; this is that logic in one place,
 * so a change to the flush policy lands on both paths at once.
 *
 * Policy: flush when the buffer reaches BATCH_MAX, otherwise on a
 * BATCH_INTERVAL_MS timer started by the first unflushed event. Callers
 * must `close()` before POSTing `/runtime/done` so the persisted
 * transcript is complete by the time the api-side resolver fires.
 *
 * A failed POST is warned about and the events are dropped: the
 * transcript is a display surface, and blocking or retrying the run on
 * it would be worse than a gap in it.
 */

import type { SessionEventKind } from "@beevibe/core";
import { errorMessage } from "@beevibe/core";
import type { ApiClient } from "./api-client.js";
import { warn } from "./logger.js";

/** Flush once this many events are buffered, without waiting for the timer. */
const BATCH_MAX = 16;

/** Time from the first unflushed event to an automatic flush. */
const BATCH_INTERVAL_MS = 250;

/** One row as the `/runtime/events` endpoint expects it. */
export interface BatchedEvent {
  session_id: string;
  kind: SessionEventKind;
  content: string;
  tool_name?: string;
}

/** What a caller supplies — `session_id` is filled in by the batcher. */
export type BatchedEventInput = Omit<BatchedEvent, "session_id">;

export interface EventBatcher {
  /** Queue an event, flushing immediately if the buffer is now full. */
  push(event: BatchedEventInput): void;
  /** Send everything buffered now, cancelling any pending timed flush. */
  flush(): Promise<void>;
  /** Final flush; no further timer fires afterwards. */
  close(): Promise<void>;
}

export function createEventBatcher(opts: {
  api: ApiClient;
  sessionId: string;
  /** Log prefix for the drop warning, e.g. `[daemon/spawner]`. */
  tag: string;
}): EventBatcher {
  const buffer: BatchedEvent[] = [];
  let flushTimer: NodeJS.Timeout | undefined;

  const clearTimer = (): void => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    if (buffer.length === 0) return;
    const events = buffer.splice(0);
    try {
      await opts.api.post("/runtime/events", { events });
    } catch (err) {
      warn(`${opts.tag} /runtime/events POST failed; events dropped:`, errorMessage(err));
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, BATCH_INTERVAL_MS);
  };

  return {
    push(event) {
      buffer.push({ session_id: opts.sessionId, ...event });
      if (buffer.length >= BATCH_MAX) void flush();
      else scheduleFlush();
    },
    flush,
    async close() {
      await flush();
    },
  };
}
