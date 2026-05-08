/**
 * On-disk daemon configuration. Lives in `~/.beevibe/config.json` and
 * survives restarts. Set during `beevibe-daemon setup`; consulted by
 * every subsequent `beevibe-daemon start`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonConfig {
  /** Beevibe API base URL (e.g. http://localhost:3000). */
  api_url: string;
  /** Stable per-machine id minted at setup, persisted across restarts. */
  external_id: string;
  /** Server-assigned daemon row id (`dmn_…`). */
  daemon_id: string;
  /** Plaintext bv_d_ token. Server keeps only the SHA-256 hash. */
  daemon_token: string;
  /**
   * Per-CLI runtime ids the server registered for this daemon. Daemon
   * subscribes to all of them via WS and polls /runtime/claim for each.
   */
  runtimes: Array<{ id: string; cli: string }>;
}

export const CONFIG_DIR = join(homedir(), ".beevibe");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): DaemonConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DaemonConfig;
  } catch (err) {
    throw new Error(
      `Daemon config at ${CONFIG_PATH} is malformed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function saveConfig(cfg: DaemonConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  // 0600 because daemon_token is an authentication credential — readable
  // only by the user that owns the daemon process.
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
