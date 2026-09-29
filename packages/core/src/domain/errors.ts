/**
 * Narrowing helpers for `catch (err: unknown)`.
 *
 * TypeScript types a caught value `unknown`, so every call site that wants
 * to log it, put it on the wire, or rethrow it has to narrow it first. Two
 * narrowings were written out by hand ~40 times across `api`, `daemon`,
 * `web`, `scheduler` and `core`:
 *
 *   err instanceof Error ? err.message : String(err)   → {@link errorMessage}
 *   err instanceof Error ? err : new Error(String(err)) → {@link toError}
 *
 * They live in `domain/` (not in a package-local util) because the sites
 * span every package, and `web` already reaches into `@beevibe/core/domain/*`
 * for the same reason `format.ts` does.
 */

/**
 * The human-readable message for a caught value.
 *
 * `String(err)` is the fallback rather than `JSON.stringify`: a thrown
 * non-Error is almost always a string or a value with a useful `toString`,
 * and `[object Object]` at least says "something odd was thrown" without
 * risking a throw of its own on a cyclic object.
 *
 * `fallback` replaces that stringification when the caller has better
 * wording for the non-Error case — the web mutation banners ("Save failed")
 * show a fixed message rather than whatever React Query happened to reject
 * with.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;
  return fallback ?? String(err);
}

/**
 * A caught value as an `Error`, wrapping it when it isn't one already.
 *
 * For the handful of call sites whose contract is `Error` rather than
 * `string` — an `onError(err: Error)` callback, a `runError` field that
 * later reads `.stack`.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
