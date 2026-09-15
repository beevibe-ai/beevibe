/**
 * The runtime shape the UI actually picks from, and the projection that
 * gets there from `GET /runtimes`.
 *
 * The response nests runtimes under the daemon that registered them, but
 * both places that let a user choose a runtime — the agent settings
 * picker and the welcome flow's "pick a runtime" step — need them flat,
 * each one carrying the label of the machine it lives on. Both wrote that
 * flattening out by hand, along with their own copy of the resulting
 * shape, and both copies had `cli_version?: string` where the route sends
 * `null` — so `shortRuntimeLabel`'s truthiness check was load-bearing
 * against a case its own types said was impossible.
 *
 * Deriving {@link RuntimeOption} from the wire type keeps that from
 * happening again: the only thing this module adds to a runtime is the
 * `device` label, and the fields it carries over say so.
 */

import type { DaemonPanelEntry, RuntimePanelEntry, RuntimesListResponse } from "@/lib/api/client";

/** A runtime plus the label of the daemon it was registered by. */
export type RuntimeOption = Pick<
  RuntimePanelEntry,
  "id" | "cli" | "cli_version" | "online"
> & {
  /** `device_name` when the daemon reported one, else its external id. */
  device: string;
};

export interface DaemonGroup {
  device: string;
  runtimes: RuntimeOption[];
}

/**
 * What to call the machine a runtime runs on.
 *
 * `device_name` is `NOT NULL` in the schema and non-optional in the
 * contract, so the fallback is belt-and-braces against a server that
 * predates either — carried over from both hand-written copies rather
 * than dropped, since a blank row in the picker is a worse failure than
 * showing an external id.
 */
function deviceLabel(daemon: DaemonPanelEntry): string {
  return daemon.device_name ?? daemon.external_id;
}

/** Group the response by daemon, keeping the device label on each runtime. */
export function groupRuntimesByDaemon(data: RuntimesListResponse | undefined): DaemonGroup[] {
  if (!data) return [];
  return data.daemons.map((d) => ({
    device: deviceLabel(d),
    runtimes: d.runtimes.map((r) => ({
      id: r.id,
      cli: r.cli,
      cli_version: r.cli_version,
      online: r.online,
      device: deviceLabel(d),
    })),
  }));
}

export function flattenRuntimes(groups: DaemonGroup[]): RuntimeOption[] {
  return groups.flatMap((g) => g.runtimes);
}

/** Every runtime across every daemon, ungrouped. */
export function listRuntimeOptions(data: RuntimesListResponse | undefined): RuntimeOption[] {
  return flattenRuntimes(groupRuntimesByDaemon(data));
}

/** `claude 1.2.3`, or just `claude` when the daemon never reported a version. */
export function shortRuntimeLabel(r: RuntimeOption): string {
  return r.cli_version ? `${r.cli} ${r.cli_version}` : r.cli;
}
