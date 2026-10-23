/**
 * On-disk daemon configuration. Lives in `<configRoot>/config.json`,
 * which defaults to `~/.beevibe/config.json` and survives restarts.
 * Set during `beevibe-daemon setup`; consulted by every subsequent
 * `beevibe-daemon start`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage } from "@beevibe/core";

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

/** Env-var entry point for the dev-only --config-root override. */
export const CONFIG_ROOT_ENV = "BEEVIBE_CONFIG_ROOT";

// Set to `false` by `bun build --define __DEV_BUILD__=false` in
// scripts/build-binaries.sh + scripts/prepare-publish.sh. Non-bundled
// runs leave it undeclared — `typeof` is what keeps tsx/vitest from
// throwing ReferenceError. Same pattern as BEEVIBE_DAEMON_VERSION in
// update.ts.
declare const __DEV_BUILD__: boolean;

/** True for source / tsx / tsc / vitest runs; false only for compiled-prod artifacts. */
export function isDevBuild(): boolean {
  return typeof __DEV_BUILD__ === "undefined" ? true : __DEV_BUILD__;
}

/**
 * Resolve the daemon's on-disk root. Precedence: explicit `override`
 * → `BEEVIBE_CONFIG_ROOT` env → `~/.beevibe`. Empty strings on either
 * input are treated as unset — guards against `WORKSPACE_ROOT=`-style
 * .env leaks (same defensive pattern as LocalWorkspaceManager).
 */
export function getConfigRoot(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env[CONFIG_ROOT_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".beevibe");
}

export function getConfigPath(override?: string): string {
  return join(getConfigRoot(override), "config.json");
}

export function loadConfig(configRoot?: string): DaemonConfig | undefined {
  const path = getConfigPath(configRoot);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonConfig;
  } catch (err) {
    throw new Error(`Daemon config at ${path} is malformed: ${errorMessage(err)}`);
  }
}

export function saveConfig(cfg: DaemonConfig, configRoot?: string): void {
  const path = getConfigPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 0600 because daemon_token is an authentication credential — readable
  // only by the user that owns the daemon process.
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
