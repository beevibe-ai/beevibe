"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Room } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

/**
 * Rooms the caller belongs to. Backs both the /rooms list page and the
 * rooms sidebar, which each had their own `useQuery` on
 * `queryKeys.rooms.list()` — with different `staleTime`s (10s and 30s)
 * against the one shared cache entry, so the sidebar's 30s was only ever
 * in effect on pages where the list page wasn't also mounted.
 *
 * 10s is kept as the single value: `room.message` is the only SSE event
 * that invalidates this key, so a room a peer created or added you to
 * surfaces on the staleTime backstop rather than on an event. The list is
 * small and the sidebar is always mounted, which is exactly where a room
 * appearing late is most visible.
 */
export function useRooms() {
  return useQuery<{ ok: true; rooms: Room[] }>({
    queryKey: queryKeys.rooms.list(),
    queryFn: ({ signal }) => api.rooms.list({ signal }),
    enabled: isApiConfigured,
    staleTime: 10_000,
  });
}
