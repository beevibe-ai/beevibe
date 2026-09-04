"use client";

import { api, type MeResponse } from "@/lib/api/client";
import { useCollectionQuery } from "./entity-query";
import { queryKeys } from "./keys";

/**
 * Identity + onboarding state for the welcome wizard. Refetches on focus
 * so a backgrounded window picks up server-side onboarding completion
 * (e.g. the chat route flipped the column after the first turn).
 */
export function useMe() {
  return useCollectionQuery<MeResponse>({
    queryKey: queryKeys.me.self(),
    fetch: api.me.self,
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
