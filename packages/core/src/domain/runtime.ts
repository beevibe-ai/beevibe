/**
 * A runtime is one (daemon, CLI) pair. A daemon registers one runtime
 * per detected CLI; agents bind by matching `runtime_config.type` to
 * `runtime.cli`, so multiple agents share a runtime when their CLIs
 * collide on the same machine.
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
