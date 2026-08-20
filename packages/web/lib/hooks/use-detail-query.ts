import { useQuery } from "@tanstack/react-query";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The shared shape of every "load one entity by id" detail query.
 *
 * Every detail hook (useTask, useAgent, useSession, useEscalation,
 * useNegotiation, …) was the same seven lines: key off `detail(id)` when an
 * id is present and `all` otherwise, fetch through the api slice's `get`,
 * and gate `enabled` on both `isApiConfigured` and a present id. This is
 * that pattern in one place — the per-entity hooks now just supply their
 * key namespace and fetcher.
 */
export function useDetailQuery<T>(opts: {
  id: string | undefined;
  detailKey: (id: string) => readonly unknown[];
  allKey: readonly unknown[];
  fetcher: (id: string, ctx: { signal?: AbortSignal }) => Promise<T>;
  staleTime?: number;
}) {
  return useQuery({
    queryKey: opts.id ? opts.detailKey(opts.id) : opts.allKey,
    queryFn: ({ signal }) => opts.fetcher(opts.id as string, { signal }),
    enabled: isApiConfigured && !!opts.id,
    staleTime: opts.staleTime,
  });
}
