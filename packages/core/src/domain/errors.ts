/**
 * Narrowing an `unknown` throwable, in the two shapes the codebase needs.
 *
 * `catch` binds `unknown`, so every call site that wants to log a message
 * or hand the failure to something typed `Error` has to narrow first. That
 * narrowing was written out by hand at ~45 sites across api, daemon,
 * scheduler, core and web — `err instanceof Error ? err.message :
 * String(err)` and its variants — including a private `asError` in
 * `services/orphan-reaper.ts`, which is the same function under a
 * different roof.
 *
 * Mostly harmless duplication, with one real edge: a handful of sites
 * wrote `: err` rather than `: String(err)`, so a thrown non-Error reached
 * `console.error` as a raw value and printed as `[object Object]` where
 * the neighbouring sites printed something readable.
 *
 * `@beevibe/sandbox` keeps its own copies on purpose: that package takes
 * no dependency on `@beevibe/core` so the sandbox trust boundary stays
 * one-way.
 */

/**
 * A human-readable message for anything thrown. `Error` contributes its
 * `.message`; everything else is stringified, so a thrown string, number
 * or plain object still logs as something you can read.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Anything thrown, as an `Error`. Pass-through when it already is one —
 * the stack is the useful part, so don't rewrap and lose it.
 */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
