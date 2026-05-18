/**
 * Probe PATH for every CLI in `KNOWN_CLIS` and capture each one's
 * `--version`. Shared by `beevibe-daemon setup` (initial registration)
 * and `beevibe-daemon sync` (post-install re-registration).
 *
 * Probes run in parallel — `<cli> --version` on a cold machine can take
 * hundreds of ms (subprocess startup + module loads), so sequential
 * probing across 3+ known CLIs becomes noticeable wall time.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KNOWN_CLIS } from "@beevibe/core";

export interface DetectedCli {
  cli: string;
  cli_version?: string;
}

const execFileAsync = promisify(execFile);

async function probeOne(cli: string): Promise<DetectedCli | null> {
  try {
    await execFileAsync("which", [cli]);
  } catch {
    return null;
  }
  let cli_version: string | undefined;
  try {
    const { stdout } = await execFileAsync(cli, ["--version"]);
    cli_version = stdout.trim().split("\n")[0];
  } catch {
    // CLI exists on PATH but --version errored. Still report the CLI;
    // version stays undefined.
  }
  return { cli, cli_version };
}

export async function detectClis(): Promise<DetectedCli[]> {
  const results = await Promise.all(KNOWN_CLIS.map((cli) => probeOne(cli)));
  return results.filter((r): r is DetectedCli => r !== null);
}
