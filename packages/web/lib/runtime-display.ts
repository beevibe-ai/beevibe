import type { RuntimesListResponse } from "@/lib/api/client";

/**
 * The flattened runtime row the UI actually renders.
 *
 * `GET /runtimes` nests runtimes under their daemon, but every surface that
 * offers a runtime to pick wants one flat list with the device name folded
 * in — the picker chip on the agent page, and the "choose a runtime" step of
 * the welcome flow. Both built that projection by hand from the same five
 * fields, and the welcome flow wrote the shape out a *third* time as an
 * inline prop type on its `RuntimeCard`.
 *
 * Three copies of a five-field shape is cheap to keep in sync right up until
 * the server's shape changes under it, which is what happened here:
 * `cli_version` is `string | null` on the wire and all three copies declared
 * it `string | undefined`. Deriving the fields from `RuntimePanelEntry`
 * rather than re-typing them means they can't disagree again.
 */
export interface RuntimeOption {
  id: string;
  cli: string;
  cli_version: string | null;
  online: boolean;
  /** `device_name`, falling back to `external_id` when unnamed. */
  device: string;
}

export interface DaemonGroup {
  device: string;
  runtimes: RuntimeOption[];
}

/** Device label for a daemon — its name, or its external id when unnamed. */
function deviceLabel(d: { device_name?: string; external_id: string }): string {
  return d.device_name ?? d.external_id;
}

/** Group the response's runtimes under their device, preserving server order. */
export function groupRuntimesByDaemon(
  data: RuntimesListResponse | undefined,
): DaemonGroup[] {
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

/** Every runtime across every daemon, as one flat list. */
export function flattenRuntimes(
  data: RuntimesListResponse | undefined,
): RuntimeOption[] {
  return groupRuntimesByDaemon(data).flatMap((g) => g.runtimes);
}

/** `claude 1.2.3`, or just `claude` when the daemon didn't report a version. */
export function shortRuntimeLabel(r: RuntimeOption): string {
  return r.cli_version ? `${r.cli} ${r.cli_version}` : r.cli;
}
