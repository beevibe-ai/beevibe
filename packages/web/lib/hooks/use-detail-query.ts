"use client";

import {
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";

/**
 * Per-call overrides. The three options this factory owns are excluded:
 * `queryKey` and `queryFn` are derived from `id`, and `enabled` carries
 * the invariant that makes the `id as string` narrowing below sound.
 */
type DetailQueryOverrides<T> = Omit<
  UseQueryOptions<T, Error, T, readonly unknown[]>,
  "queryKey" | "queryFn" | "enabled"
>;

/**
 * Key pair for a detail query: the resource-wide prefix plus the
 * per-entity key. Every `queryKeys.<resource>` group in `./keys` already
 * has this shape, so a call site passes the group itself.
 *
 * `detail` is a function rather than a fixed name because the key isn't
 * always called `detail` — `sessions.conversation(shortId)` is the same
 * id-keyed query under a different slot.
 */
export interface DetailQueryKeys {
  all: readonly unknown[];
  detail: (id: string) => readonly unknown[];
}

/**
 * The "fetch one entity by id" query every detail surface runs.
 *
 * Eight call sites had spelled out the same four lines — the
 * `id ? detail(id) : all` key, the `api.<resource>.get(id, { signal })`
 * fetcher, and `enabled: isApiConfigured && !!id` — once each for agents,
 * tasks, sessions, conversations, escalations, negotiations, rooms and
 * work products.
 *
 * The part worth having in one place is the cast. `queryFn` runs only
 * when `enabled` is true, which is only when `id` is a non-empty string,
 * so narrowing it is sound — but that soundness lives in the
 * *relationship* between two options, which is exactly what a reader
 * can't check locally. Eight copies meant eight `id as string` casts
 * each individually relying on a guard four lines above it. This is one
 * cast whose guard is written directly beneath it and can't be dropped
 * by a call site.
 *
 * The `id ? … : all` fallback key is preserved as-is: while `id` is
 * undefined the query is disabled, so the key is never fetched against —
 * it only has to be stable and not collide with a real entity's slot.
 */
export function useDetailQuery<T>(
  id: string | undefined,
  keys: DetailQueryKeys,
  fetch: (id: string, opts: { signal: AbortSignal }) => Promise<T>,
  overrides: DetailQueryOverrides<T> = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T, readonly unknown[]>({
    ...overrides,
    queryKey: id ? keys.detail(id) : keys.all,
    queryFn: ({ signal }) => fetch(id as string, { signal }),
    enabled: isApiConfigured && !!id,
  });
}
