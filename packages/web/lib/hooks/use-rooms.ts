"use client";

import { api, type Room, type RoomDetail } from "@/lib/api/client";
import { useApiDetailQuery, useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

/**
 * Rooms the caller belongs to. Both the rooms sidebar and the /rooms
 * index rendered this query inline; they kept different `staleTime`s
 * (30s in the sidebar, 10s on the page that also creates rooms), so
 * that stays a parameter rather than being flattened to one value.
 */
export function useRooms({ staleTime = 30_000 }: { staleTime?: number } = {}) {
  return useApiQuery<{ ok: true; rooms: Room[] }>(
    queryKeys.rooms.list(),
    ({ signal }) => api.rooms.list({ signal }),
    { staleTime },
  );
}

export function useRoom(roomId: string | undefined) {
  return useApiDetailQuery<RoomDetail>(
    roomId,
    queryKeys.rooms,
    (id, opts) => api.rooms.get(id, opts),
    {
      staleTime: 1_000,
      // Polling fallback — cloudflared trycloudflare quick tunnels
      // buffer SSE responses, so the bv_event channel often fails to
      // propagate to remote browsers. SSE remains the fast path when
      // it works (sub-second latency); this 3s poll guarantees the
      // room view eventually catches up regardless of the tunnel.
      refetchInterval: 3_000,
      refetchIntervalInBackground: false,
    },
  );
}
