/**
 * On-disk daemon configuration. Lives in `<configRoot>/config.json` and
 * survives restarts. Set during `beevibe-daemon setup`; consulted by
 * every subsequent `beevibe-daemon start`.
 *
 * `configRoot` defaults to `~/.beevibe` and can be overridden per process
 * (dev builds only) via `--config-root` or `BEEVIBE_CONFIG_ROOT`. The
 * override exists so a developer can run two daemons on one machine
 * authenticated as different `bv_u_` accounts without the second `setup`
 * clobbering the first daemon's `bv_d_` token. Prod (Bun-compiled binary
 * or npm-bundle) rejects the flag and env via `isDevBuild()` in main.ts.
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

/**
 * Baked in by `bun build --define __DEV_BUILD__=false` for the binary /
 * npm-publish artifacts (see scripts/build-binaries.sh,
 * scripts/prepare-publish.sh). Non-bundled runs (tsx, `tsc → node`,
 * vitest) never have the define applied, which is why `isDevBuild()`
 * probes via `typeof` — the global is undeclared in those contexts and
 * referencing it directly would ReferenceError.
 */
declare const __DEV_BUILD__: boolean;

/**
 * True when running from source (tsx / tsc-built dist / vitest). False
 * only in artifacts built by build-binaries.sh / prepare-publish.sh,
 * which pass `--define "__DEV_BUILD__=false"`.
 *
 * Multi-instance entry points (`--config-root`, `BEEVIBE_CONFIG_ROOT`)
 * gate on this — prod builds reject both with exit code 2 so an end
 * user can't accidentally fork a daemon's state.
 */
export function isDevBuild(): boolean {
  // typeof on an undeclared global returns "undefined" rather than
  // throwing — same global-probe pattern as BEEVIBE_DAEMON_VERSION in
  // update.ts. Compiled-prod sets the define to `false` explicitly.
  return typeof __DEV_BUILD__ === "undefined" ? true : __DEV_BUILD__;
}

/**
 * Resolve the daemon's on-disk root directory. Precedence:
 *   1. explicit `override` arg (the `--config-root` flag)
 *   2. `BEEVIBE_CONFIG_ROOT` env var
 *   3. `~/.beevibe` (unchanged default)
 *
 * Default behavior is identical to the pre-flag world — with no
 * override and no env, paths resolve to `~/.beevibe/...` exactly as
 * before. The override path is dev-only; main.ts rejects it in
 * compiled-prod via `isDevBuild()`.
 */
export function getConfigRoot(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.BEEVIBE_CONFIG_ROOT;
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
    throw new Error(
      `Daemon config at ${path} is malformed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function saveConfig(cfg: DaemonConfig, configRoot?: string): void {
  const path = getConfigPath(configRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 0600 because daemon_token is an authentication credential — readable
  // only by the user that owns the daemon process.
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
