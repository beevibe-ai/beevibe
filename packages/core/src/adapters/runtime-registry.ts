import type { RuntimeRegistry } from "../ports/runtime.js";
import { ClaudeCodeRuntime } from "./claude-code/runtime.js";
import { CodexRuntime } from "./codex/runtime.js";
import { HermesRuntime } from "./hermes/runtime.js";
import { OpenCodeRuntime } from "./opencode/runtime.js";

/**
 * Default registry with all production runtimes wired.
 *
 * Used by both the executor (M5) and the api server (M6) composition roots —
 * mesh tool handlers in M6 spawn CLIs via `AgentSession`, which needs the same
 * registry. Centralizing here avoids the executor-vs-api duplication that a
 * bootstrap-literal would require. Adding a new runtime (codex, amp, etc.) is
 * a one-line change + one new adapter file; both composition roots pick it up
 * automatically.
 *
 * Runtime instances are shared across all dispatches for the same
 * `agent.runtime_config.type` — they are stateless (each `execute()` spawns
 * a fresh subprocess), so a single instance serves all agents of that type.
 */
export function createDefaultRuntimeRegistry(): RuntimeRegistry {
  return {
    claude: new ClaudeCodeRuntime({}),
    codex: new CodexRuntime({}),
    opencode: new OpenCodeRuntime({}),
    hermes: new HermesRuntime({}),
  };
}

/**
 * Producer-consumer pair for the "daemon got a dispatch for a CLI it
 * doesn't have registered" error string — daemon throws via
 * `runtimeMissingError(cli)`; api side parses via `parseRuntimeMissingError`
 * to swap for a user-actionable message in the chat surface. Co-located
 * here so the two stay byte-for-byte in sync; mirrors the
 * `bareCliExitMessage` / `isBareCliExitMessage` pair in claude-code's
 * stream-json module.
 */
export function runtimeMissingError(cli: string): string {
  return `No runtime registered for dispatch payload type '${cli}'`;
}

const RUNTIME_MISSING_PATTERN = /^No runtime registered for dispatch payload type '([^']+)'$/;

export function parseRuntimeMissingError(s: string): string | undefined {
  return s.match(RUNTIME_MISSING_PATTERN)?.[1];
}
