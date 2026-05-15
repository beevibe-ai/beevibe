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
  "task.updated": [
    queryKeys.tasks.all,
    queryKeys.dashboard.all,
    queryKeys.activity.all,
    queryKeys.inbox.all,
  ],
  "task.created": [
    queryKeys.tasks.all,
    queryKeys.dashboard.all,
    queryKeys.activity.all,
    queryKeys.inbox.all,
  ],
  "agent.updated": [
    queryKeys.agents.all,
    queryKeys.activity.all,
    queryKeys.agentNetwork.all,
  ],
  "session.updated": [
    queryKeys.sessions.all,
    queryKeys.tasks.all,
    queryKeys.activity.all,
    // Match ALL chat history slots, not just the `<latest>` one. A user
    // viewing a specific conversation (cacheId = conv head) needs the
    // same auto-recovery: when their pending chat session completes, the
    // cache slot for that conversation has to refetch. The `historyAll`
    // prefix invalidates every per-conversation slot under it. We do NOT
    // fan out to `chat.conversations` — the sidebar chain head only
    // changes when a new conversation is opened, and `use-chat`'s
    // onSuccess already invalidates it explicitly. Refetching it on
    // every non-chat session.updated (task/mesh transitions) would be
    // pure waste.
    queryKeys.chat.historyAll,
  ],
  "memory.fact.created": [queryKeys.memory.all],
  "memory.fact.deleted": [queryKeys.memory.all],
  "promotion.created": [queryKeys.promotions.all, queryKeys.memory.all],
  "mesh.activity": [queryKeys.mesh.all, queryKeys.activity.all, queryKeys.inbox.all],
  "room.message": [queryKeys.rooms.all, queryKeys.activity.all],
  "runtime.updated": [queryKeys.runtimes.all, queryKeys.agents.all],
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
//
// Buffering-proxy detection: cloudflared trycloudflare quick tunnels
// buffer SSE responses, so the EventSource opens but no data ever
// arrives → browser times out → reconnect → repeat (the "stream
// canceled by remote" log spam). If the first connection attempt
// receives no data within HEALTH_TIMEOUT_MS, we mark SSE as
// unhealthy for this page session and stop trying. Polling carries
// the load. UI exposes the status via `getLiveStatus()`.

type Listener = (e: BvEvent) => void;

const HEALTH_TIMEOUT_MS = 8_000;

type LiveStatus = "connecting" | "live" | "polling-only";

let source: EventSource | undefined;
let refCount = 0;
const listeners = new Set<Listener>();
let sseDisabled = false;
let status: LiveStatus = "connecting";
const statusListeners = new Set<(s: LiveStatus) => void>();

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  for (const cb of statusListeners) {
    try {
      cb(status);
    } catch {
      /* ignore */
    }
  }
}

export function getLiveStatus(): LiveStatus {
  return status;
}

export function subscribeLiveStatus(cb: (s: LiveStatus) => void): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function ensureSource(): EventSource | undefined {
  if (!isApiConfigured || !apiBaseUrl || typeof window === "undefined") return undefined;
  if (source) return source;
  // Once we've decided the proxy buffers SSE, don't keep trying — the
  // browser would auto-reconnect every ~6s and spam the api log.
  if (sseDisabled) return undefined;
  const key = getUserKey();
  // No key = unauthenticated; bail. Visitor needs to sign in first.
  if (!key) return undefined;
  const url = new URL(`${apiBaseUrl}/api/stream`);
  url.searchParams.set("token", key);
  setStatus("connecting");
  const created = new EventSource(url.toString(), { withCredentials: true });
  source = created;

  let receivedAnyData = false;

  // Health probe — if we don't see any bytes within HEALTH_TIMEOUT_MS,
  // assume the proxy is buffering and disable SSE for the rest of
  // this tab session. The server emits ":connected\n\n" + a heartbeat
  // every 5s, so on a healthy connection we trip this within ~1s.
  const healthTimer = setTimeout(() => {
    if (!receivedAnyData && source === created) {
      console.info(
        "[sse] no bytes within %dms — proxy likely buffering; falling back to polling.",
        HEALTH_TIMEOUT_MS,
      );
      sseDisabled = true;
      setStatus("polling-only");
      try {
        created.close();
      } catch {
        /* ignore */
      }
      source = undefined;
    }
  }, HEALTH_TIMEOUT_MS);

  const ackData = () => {
    if (!receivedAnyData) {
      receivedAnyData = true;
      clearTimeout(healthTimer);
      setStatus("live");
    }
  };

  created.onmessage = (e) => {
    ackData();
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
      // heartbeats (": ..." comment lines) or non-JSON; the data
      // arrival itself is the signal we needed.
    }
  };

  // EventSource fires onerror when the stream drops. If we haven't
  // received any data, treat it like the buffering case and stop
  // retrying. If we DID receive data, EventSource will auto-reconnect
  // and that's fine.
  created.onerror = () => {
    if (receivedAnyData) return; // let EventSource reconnect
    console.info("[sse] error before any data — falling back to polling.");
    sseDisabled = true;
    setStatus("polling-only");
    clearTimeout(healthTimer);
    try {
      created.close();
    } catch {
      /* ignore */
    }
    if (source === created) source = undefined;
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
  statusListeners.clear();
  sseDisabled = false;
  status = "connecting";
}

export function useLiveUpdates() {
  const client = useQueryClient();
  useEffect(() => {
    return subscribe((ev) => invalidate(client, ev.event));
  }, [client]);
}
