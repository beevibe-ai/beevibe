/**
 * Probe PATH for every CLI in `KNOWN_CLIS` and capture each one's
 * `--version`. Shared by `beevibe-daemon setup` (initial registration)
 * and `beevibe-daemon sync` (post-install re-registration).
 */

import { spawnSync } from "node:child_process";
import { KNOWN_CLIS } from "@beevibe/core";

export interface DetectedCli {
  cli: string;
  cli_version?: string;
}

export function detectClis(): DetectedCli[] {
  const out: DetectedCli[] = [];
  for (const cli of KNOWN_CLIS) {
    const which = spawnSync("which", [cli], { encoding: "utf8" });
    if (which.status !== 0 || !which.stdout.trim()) continue;
    const version = spawnSync(cli, ["--version"], { encoding: "utf8" });
    out.push({
      cli,
      cli_version:
        version.status === 0 ? version.stdout.trim().split("\n")[0] : undefined,
    });
  }
  return out;
}
