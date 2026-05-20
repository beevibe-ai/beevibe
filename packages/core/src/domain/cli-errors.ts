/**
 * Classifiers for the well-known error strings adapters and the daemon emit
 * when a CLI subprocess fails in a structured-but-stringly way. Consumers
 * (chiefly the api chat route) gate on these predicates to swap an opaque
 * stand-in for a user-actionable diagnostic.
 *
 * Lives in `domain/` rather than under any single adapter because the
 * importing surface — request-handling code that has no business depending
 * on a specific runtime — must not reach into adapter packages to do
 * error classification. Producers stay in their respective adapter / daemon
 * modules and reference these matchers' patterns via the round-trip tests
 * that pair them.
 */

const BARE_CLI_EXIT_PATTERN = /^CLI exited with code (-?\d+|null)$/;

/**
 * Matches the placeholder string emitted when a CLI exited non-zero with
 * no final-result message — see `bareCliExitMessage` in
 * `adapters/claude-code/stream-json.ts` for the producer. Both the
 * codex and opencode adapters reuse the same producer so the format
 * stays in lock-step across runtimes.
 */
export function isBareCliExitMessage(s: string): boolean {
  return BARE_CLI_EXIT_PATTERN.test(s);
}

const RUNTIME_MISSING_PATTERN =
  /^No runtime registered for dispatch payload type '([^']+)'$/;

/**
 * Matches the error string the daemon throws when it receives a dispatch
 * payload for a CLI it doesn't have registered — see `runtimeMissingError`
 * in `adapters/runtime-registry.ts` for the producer. Returns the offending
 * CLI name on a match, `undefined` otherwise. The producer/consumer pair
 * is round-tripped in `adapters/runtime-registry.test.ts`.
 */
export function parseRuntimeMissingError(s: string): string | undefined {
  return s.match(RUNTIME_MISSING_PATTERN)?.[1];
}
