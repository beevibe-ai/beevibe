/**
 * A runtime is one (daemon, CLI) pair. A daemon registers one runtime
 * per detected CLI; agents bind by matching `runtime_config.type` to
 * `runtime.cli`, so multiple agents share a runtime when their CLIs
 * collide on the same machine.
 */

export const KNOWN_CLIS = ["claude", "codex", "opencode", "hermes"] as const;

export type KnownCli = (typeof KNOWN_CLIS)[number];

export function isKnownCli(v: unknown): v is KnownCli {
  return typeof v === "string" && (KNOWN_CLIS as readonly string[]).includes(v);
}

/**
 * Daemon → api heartbeat cadence. Single source of truth so the
 * server-side freshness window can derive from it (see `DaemonHub`'s
 * ONLINE_FRESHNESS_MS = 2× this) and the daemon's claimer uses the
 * same default. Don't drift these two — the hub's "1 missed beat OK"
 * tolerance assumes the daemon ships at exactly this cadence.
 */
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 15_000;

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
