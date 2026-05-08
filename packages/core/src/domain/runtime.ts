/**
 * A runtime represents one (daemon, CLI) pair — a single daemon
 * detects N CLIs on PATH (claude, codex, opencode, …) and registers
 * one runtime per detected CLI. Agents bind to a runtime by matching
 * their `runtime_config.type` against `runtime.cli`. Multiple agents
 * using the same CLI on the same machine share one runtime row.
 *
 * `last_heartbeat` is updated by the daemon every tick per registered
 * runtime; queries derive online/offline by comparing against now() -
 * a threshold (defaults to 90s on the server side).
 */

export interface Runtime {
  id: string;
  daemon_id: string;
  cli: string;
  cli_version?: string;
  last_heartbeat?: Date;
  capabilities: Record<string, unknown>;
  created_at: Date;
}

export type NewRuntime = Omit<Runtime, "created_at" | "last_heartbeat" | "capabilities"> & {
  created_at?: Date;
  capabilities?: Record<string, unknown>;
};
