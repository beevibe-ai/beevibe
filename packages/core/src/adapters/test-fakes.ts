import type { CliProcessResult } from "./claude-code/spawn.js";

/**
 * Fixtures shared by the CLI-subprocess adapter tests (claude-code, codex,
 * opencode) and by `runtime-common.test.ts`.
 *
 * Companion to `adapters/runtime-common.ts`: that module holds the runtime
 * code those three adapters share, this one holds the test fixtures.
 */

/**
 * A settled `CliProcessResult`, defaulting to a clean exit with no output.
 *
 * All four test files spelled out the same eight fields — three as a
 * `MOCK_OK` constant, one already as this exact factory — so adding a field
 * to `CliProcessResult` meant editing four literals. `stdout` is the only
 * one that ever really varies between them: each adapter drives its parser
 * from its own canonical NDJSON fixture.
 *
 * The per-adapter `mockRunCli` / `ctx` helpers stay local on purpose. They
 * look similar but genuinely differ — codex's mock also writes the
 * `--output-last-message` file, and each `ctx` picks a workspace path that
 * suits that adapter — and a test's mock is the one thing a reader of the
 * file should not have to go elsewhere to understand.
 */
export function cliResult(overrides: Partial<CliProcessResult> = {}): CliProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    pid: 9999,
    process_group_id: 9999,
    truncated: false,
    ...overrides,
  };
}
