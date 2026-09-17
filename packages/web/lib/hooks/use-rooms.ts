"use client";

import { api, type Room, type RoomDetail } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "./keys";
import { useDetailQuery } from "./use-detail-query";

/**
 * The caller's rooms.
 *
 * The /rooms list page and the rooms sidebar each declared this inline
 * against the same `queryKeys.rooms.list()` key but disagreed on
 * `staleTime` (10s on the page, 30s in the sidebar). Both render at once
 * on /rooms, so which one won depended on mount order — the shared cache
 * entry takes whichever observer's bound is tighter. 10s is kept: it was
 * the page's own choice for the surface where rooms are created, and
 * tightening the sidebar to match is the direction that can only add
 * freshness.
 */
export function useRooms() {
  return useQuery<{ ok: true; rooms: Room[] }>({
    queryKey: queryKeys.rooms.list(),
    queryFn: ({ signal }) => api.rooms.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });
}

/**
 * One room with its members and transcript.
 *
 * The 3s poll is a fallback, not the fast path: cloudflared quick
 * tunnels buffer SSE responses, so the `bv_event` channel often fails to
 * reach remote browsers. SSE stays sub-second where it works; this
 * guarantees the room view catches up regardless of the tunnel.
 */
export function useRoom(roomId: string | undefined) {
  return useDetailQuery<RoomDetail>(
    roomId,
    queryKeys.rooms,
    (id, opts) => api.rooms.get(id, opts),
    {
      staleTime: 1_000,
      refetchInterval: 3_000,
      refetchIntervalInBackground: false,
    },
  );
}
