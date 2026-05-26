/**
 * `beevibe-daemon sync` — pick up a newly-installed CLI on this machine
 * without rotating the daemon's identity.
 *
 * Reads ~/.beevibe/config.json, re-runs detectClis(), POSTs the result
 * to /runtime/sync (bv_d_ auth — no human token needed), and writes
 * back the full runtime list returned by the api. Caller must restart
 * `beevibe-daemon start` to make the new runtime ids show up in the
 * poll loop.
 */

import { KNOWN_CLIS } from "@beevibe/core";
import { ApiClient } from "./api-client.js";
import { getConfigPath, loadConfig, saveConfig, type DaemonConfig } from "./config.js";
import { detectClis } from "./detect-clis.js";

interface SyncResponse {
  runtimes: Array<{ id: string; cli: string }>;
}

export interface SyncResult {
  /** Runtimes added since the previous config. */
  added: Array<{ id: string; cli: string }>;
  /** Full runtime list after the sync. */
  runtimes: Array<{ id: string; cli: string }>;
}

export interface SyncOptions {
  /**
   * Dev-only override for `~/.beevibe`. Threaded down from the
   * `--config-root` flag in main.ts. Unset for normal use.
   */
  configRoot?: string;
}

export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  const config = loadConfig(options.configRoot);
  if (!config) {
    throw new Error(
      `No daemon config at ${getConfigPath(options.configRoot)}. Run 'beevibe-daemon setup' first.`,
    );
  }

  const detected = await detectClis();
  if (detected.length === 0) {
    throw new Error(
      `No supported CLIs detected on PATH. beevibe currently looks for: ${KNOWN_CLIS.join(", ")}`,
    );
  }

  const api = new ApiClient({
    apiUrl: config.api_url,
    daemonToken: config.daemon_token,
  });
  const { status, body } = await api.post<SyncResponse>("/runtime/sync", {
    runtimes: detected,
  });
  if (status !== 200 || !body) {
    throw new Error(`/runtime/sync failed: ${status}`);
  }

  const before = new Set(config.runtimes.map((r) => r.cli));
  const added = body.runtimes.filter((r) => !before.has(r.cli));

  const next: DaemonConfig = { ...config, runtimes: body.runtimes };
  saveConfig(next, options.configRoot);

  return { added, runtimes: body.runtimes };
}
