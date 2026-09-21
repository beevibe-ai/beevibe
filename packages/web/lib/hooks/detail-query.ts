import type { ReadOptions } from "@/lib/api/client";
import { isApiConfigured } from "@/lib/api/config";

/**
 * The "fetch one entity by id" query, in one place.
 *
 * `useAgent`, `useTask`, `useSession`, `useEscalation` and
 * `useNegotiation` are the same hook over five resources: key off
 * `<resource>.detail(id)`, fall back to the resource's root key while
 * the id is still undefined, fetch with the request's abort signal,
 * and stay disabled until both the api is configured and an id exists.
 *
 * The id is optional because these hooks are called from route
 * components before the param resolves. That is also where the shape
 * was quietly unsound: each copy narrowed with `api.x.get(id as
 * string)`, asserting away an `undefined` that `enabled` — not the
 * type system — rules out. Five identical casts is five places to get
 * the `enabled` guard wrong; this has one, next to the guard that
 * justifies it.
 *
 * Returns options rather than calling `useQuery` itself so callers
 * keep composing: `useConversation` adds a `staleTime`, and a caller
 * wanting `select` or `placeholderData` can spread this and add it.
 */
export function detailQueryOptions<T>(
  keys: {
    all: readonly unknown[];
    detail: (id: string) => readonly unknown[];
  },
  fetch: (id: string, opts: ReadOptions) => Promise<T>,
  id: string | undefined,
): {
  queryKey: readonly unknown[];
  queryFn: (ctx: { signal: AbortSignal }) => Promise<T>;
  enabled: boolean;
} {
  return {
    queryKey: id ? keys.detail(id) : keys.all,
    // Safe: `enabled` below is false whenever `id` is undefined, so
    // react-query never invokes this. The non-null assertion is the
    // one the five call sites each used to spell as `id as string`.
    queryFn: ({ signal }) => fetch(id!, { signal }),
    enabled: isApiConfigured && !!id,
  };
}
