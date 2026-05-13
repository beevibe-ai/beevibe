"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type HealthResponse, type MeResponse } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";
import { queryKeys } from "./keys";

/**
 * Identity + onboarding state for the welcome wizard. Refetches on focus
 * so a backgrounded window picks up server-side onboarding completion
 * (e.g. the chat route flipped the column after the first turn).
 */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: queryKeys.me.self(),
    queryFn: ({ signal }) => api.me.self({ signal }),
    enabled: isApiConfigured,
    staleTime: 0,
  });
}

/**
 * Tri-state ownership check: `true`/`false` once `useMe` resolves, `null`
 * while loading. Callers gate edit affordances on `=== true` so the
 * loading state shows neither owner UI nor read-only UI — avoids the
 * flicker of owners briefly seeing the read-only layout on cold mount.
 */
export function useIsOwner(ownerId: string | undefined): boolean | null {
  const me = useMe();
  if (!me.data) return null;
  return me.data.person.id === ownerId;
}

export function useLlmHealth(enabled = true) {
  return useQuery<HealthResponse>({
    queryKey: queryKeys.me.health(),
    queryFn: ({ signal }) => api.me.health({ signal }),
    enabled: isApiConfigured && enabled,
    retry: false,
    staleTime: 5_000,
  });
}

export function useCompleteOnboarding() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.me.completeOnboarding(),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.me.all });
    },
  });
}
