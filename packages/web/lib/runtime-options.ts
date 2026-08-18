/**
 * Flattened runtime rows for the two surfaces that let a user pick a CLI:
 * the agent-settings runtime picker and the welcome walkthrough. Both turn
 * `GET /runtimes` into the same "<device> · <cli> <version>" option, so the
 * shape and the flattening live here instead of being re-derived per file.
 *
 * `device` comes from the daemon's `device_name`, which is `NOT NULL` in the
 * schema — the old `?? external_id` fallbacks were unreachable.
 */

import type { RuntimesListResponse } from "@/lib/types/runtimes";

export interface RuntimeOption {
  id: string;
  cli: string;
  cli_version: string | null;
  online: boolean;
  /** The daemon's device name — the machine this runtime runs on. */
  device: string;
}

export interface DaemonGroup {
  device: string;
  runtimes: RuntimeOption[];
}

/** One group per daemon, preserving the server's ordering. */
export function groupRuntimesByDaemon(
  data: RuntimesListResponse | undefined,
): DaemonGroup[] {
  if (!data) return [];
  return data.daemons.map((d) => ({
    device: d.device_name,
    runtimes: d.runtimes.map((r) => ({
      id: r.id,
      cli: r.cli,
      cli_version: r.cli_version,
      online: r.online,
      device: d.device_name,
    })),
  }));
}

/** Every runtime across every daemon, flattened. */
export function toRuntimeOptions(
  data: RuntimesListResponse | undefined,
): RuntimeOption[] {
  return groupRuntimesByDaemon(data).flatMap((g) => g.runtimes);
}
