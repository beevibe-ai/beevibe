/**
 * The one place that turns an unknown thrown value into a string.
 *
 * `catch (err)` gives back `unknown`, and every layer that wants to log
 * it, put it on the wire, or store it in a column has to narrow it
 * first. The narrowing was written out longhand — `err instanceof Error
 * ? err.message : String(err)` — at 39 call sites across `api`,
 * `daemon`, `sandbox` and `web`, which made it the most-repeated
 * expression in the tree. Two packages had already noticed and grown a
 * private helper for it (`errMsg` in `api/src/tools/find-repo.ts`, the
 * tail of `describeError` in `web/lib/api/http.ts`).
 *
 * `String(err)` alone is not a substitute: on an Error it yields
 * `"Error: boom"` rather than `"boom"`, so the prefix would leak into
 * error envelopes and log lines that currently carry only the message.
 * That asymmetry is exactly why the ternary keeps getting written out.
 *
 * Pure and dependency-free, so it is safe anywhere — including modules
 * that end up in the browser bundle. Reach it via
 * `@beevibe/core/domain/errors` from a client component, for the same
 * `node:crypto` reason documented on `domain/format.ts`.
 */

/**
 * The human-readable message for a caught value: an `Error`'s `message`,
 * or the value stringified for anything else (a thrown string, a
 * rejected non-Error, `undefined` from an aborted promise).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
