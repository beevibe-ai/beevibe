"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiBaseUrl, getUserKey, isApiConfigured, subscribeToUserKey } from "./api/config";
import { queryKeys } from "./hooks/keys";

/**
 * Mirrors the api server's `BvEvent`. `data` is undefined for
 * cache-invalidation events (task.updated etc.) — those drive query
 * refetches. Push events (session.step) carry their payload inline.
 */
export interface BvEvent {
  event: string;
  id: string;
  data?: Record<string, unknown>;
}

type InvalidationKey = readonly unknown[];

const eventInvalidations: Record<string, InvalidationKey[]> = {
  "task.updated": [queryKeys.tasks.all, queryKeys.dashboard.all, queryKeys.activity.all],
  "task.created": [queryKeys.tasks.all, queryKeys.dashboard.all, queryKeys.activity.all],
  "agent.updated": [queryKeys.agents.all, queryKeys.activity.all],
  "session.updated": [queryKeys.sessions.all, queryKeys.tasks.all, queryKeys.activity.all],
  "memory.fact.created": [queryKeys.memory.all],
  "promotion.created": [queryKeys.promotions.all, queryKeys.memory.all],
  "mesh.activity": [queryKeys.mesh.all, queryKeys.activity.all],
  "room.message": [queryKeys.rooms.all, queryKeys.activity.all],
};

function invalidate(client: QueryClient, eventName: string) {
  const keys = eventInvalidations[eventName];
  if (!keys) return;
  for (const key of keys) {
    client.invalidateQueries({ queryKey: key });
  }
}

// ── Shared EventSource bus ─────────────────────────────────────────────────
// One EventSource per page; many subscribers. useLiveUpdates handles cache
// invalidation; useSseEvents lets components subscribe to raw events.

type Listener = (e: BvEvent) => void;

let source: EventSource | undefined;
let refCount = 0;
const listeners = new Set<Listener>();

function ensureSource(): EventSource | undefined {
  if (!isApiConfigured || !apiBaseUrl || typeof window === "undefined") return undefined;
  if (source) return source;
  const key = getUserKey();
  // No key = unauthenticated; bail. Visitor needs to sign in first.
  if (!key) return undefined;
  const url = new URL(`${apiBaseUrl}/api/stream`);
  url.searchParams.set("token", key);
  source = new EventSource(url.toString(), { withCredentials: true });
  source.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as Partial<BvEvent>;
      if (typeof parsed.event !== "string" || typeof parsed.id !== "string") return;
      const ev: BvEvent = {
        event: parsed.event,
        id: parsed.id,
        ...(parsed.data ? { data: parsed.data } : {}),
      };
      for (const cb of listeners) {
        try {
          cb(ev);
        } catch (err) {
          console.error("[sse] subscriber threw:", err);
        }
      }
    } catch {
      // heartbeats / non-JSON
    }
  };
  return source;
}

// Resubscribe whenever the user key changes (sign-in / sign-out) so the
// EventSource carries the new token. The current source has the old
// token baked into its URL, so we close and let the next subscriber
// recreate it.
let unsubscribeKeyWatcher: (() => void) | undefined;
function ensureKeyWatcher(): void {
  if (unsubscribeKeyWatcher) return;
  unsubscribeKeyWatcher = subscribeToUserKey(() => {
    if (source) {
      source.close();
      source = undefined;
    }
    if (refCount > 0) ensureSource();
  });
}

function subscribe(cb: Listener): () => void {
  ensureKeyWatcher();
  ensureSource();
  listeners.add(cb);
  refCount += 1;
  return () => {
    listeners.delete(cb);
    refCount -= 1;
    if (refCount <= 0 && source) {
      source.close();
      source = undefined;
      refCount = 0;
    }
  };
}

/** Subscribe to all SSE events. Subscription cleanup is handled by useEffect. */
export function useSseEvents(callback: Listener) {
  useEffect(() => subscribe(callback), [callback]);
}

/** @internal Tests only — reset the shared connection between cases. */
export function __resetSseStateForTests(): void {
  if (source) {
    try {
      source.close();
    } catch {
      // ignore
    }
  }
  source = undefined;
  refCount = 0;
  listeners.clear();
}

export function useLiveUpdates() {
  const client = useQueryClient();
  useEffect(() => {
    return subscribe((ev) => invalidate(client, ev.event));
  }, [client]);
}
