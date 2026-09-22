"use client";

import { api, type RuntimesListResponse } from "@/lib/api/client";
import { useApiQuery } from "./api-query";
import { queryKeys } from "./keys";

export function useRuntimes() {
  return useApiQuery<RuntimesListResponse>(
    queryKeys.runtimes.list(),
    ({ signal }) => api.runtimes.list({ signal }),
    {
      // SSE invalidates this key on `runtime.updated`; keep cache otherwise
      // long so per-render polling doesn't fight the live updates.
      staleTime: 30_000,
    },
  );
}
