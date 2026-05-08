import type { NewRuntime, Runtime } from "../domain/runtime.js";

export type RuntimePatch = Partial<
  Pick<Runtime, "cli_version" | "last_heartbeat" | "capabilities">
>;

export interface RuntimeRepository {
  findById(id: string): Promise<Runtime | undefined>;

  /**
   * Used by `/runtime/register`: a daemon registers one runtime per
   * detected CLI. (daemon_id, cli) is unique; re-registering returns
   * the existing row.
   */
  findByDaemonAndCli(daemonId: string, cli: string): Promise<Runtime | undefined>;

  /** All runtimes for a daemon (Runtimes panel). */
  listByDaemon(daemonId: string): Promise<Runtime[]>;

  /**
   * Used by agent-creation gating ("does this caller have a registered
   * `claude` runtime?") and by the scheduler to find candidate runtimes
   * for a given CLI.
   */
  listByOwnerAndCli(ownerPersonId: string, cli: string): Promise<Runtime[]>;

  create(input: NewRuntime): Promise<Runtime>;

  update(id: string, patch: RuntimePatch): Promise<Runtime>;

  /** Stamp last_heartbeat=now(). Fires bv_event 'runtime.updated' via trigger. */
  heartbeat(id: string): Promise<void>;
}
