"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiBaseUrl, isApiConfigured, userKey } from "./api/config";
import { queryKeys } from "./hooks/keys";

type InvalidationKey = readonly unknown[];

const eventInvalidations: Record<string, InvalidationKey[]> = {
  "task.updated": [queryKeys.tasks.all, queryKeys.dashboard.all],
  "task.created": [queryKeys.tasks.all, queryKeys.dashboard.all],
  "agent.updated": [queryKeys.agents.all],
  "session.updated": [queryKeys.sessions.all, queryKeys.tasks.all],
  "memory.fact.created": [queryKeys.memory.all],
  "promotion.created": [queryKeys.promotions.all, queryKeys.memory.all],
  "mesh.activity": [queryKeys.mesh.all],
};

function invalidate(client: QueryClient, eventName: string) {
  const keys = eventInvalidations[eventName];
  if (!keys) return;
  for (const key of keys) {
    client.invalidateQueries({ queryKey: key });
  }
}

export function useLiveUpdates() {
  const client = useQueryClient();

  useEffect(() => {
    if (!isApiConfigured || !apiBaseUrl) return;

    // EventSource can't set custom headers, so the bv_u_ token rides along
    // as a query param — see `createStreamAuthMiddleware` on the api side.
    const url = new URL(`${apiBaseUrl}/api/stream`);
    if (userKey) url.searchParams.set("token", userKey);
    const source = new EventSource(url.toString(), { withCredentials: true });

    source.onmessage = (e) => {
      try {
        const parsed: unknown = JSON.parse(e.data);
        if (typeof parsed === "object" && parsed !== null && "event" in parsed) {
          const eventName = (parsed as { event: unknown }).event;
          if (typeof eventName === "string") invalidate(client, eventName);
        }
      } catch {
        // ignore non-JSON messages (heartbeats, etc.)
      }
    };

    return () => source.close();
  }, [client]);
}
