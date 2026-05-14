import type { RuntimeRegistry } from "../ports/runtime.js";
import { ClaudeCodeRuntime } from "./claude-code/runtime.js";

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
  };
}
