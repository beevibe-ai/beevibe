/**
 * `beevibe-daemon setup --api <url> --user-token <bv_u_…>` — one-shot
 * registration. Detects CLIs on PATH, posts /runtime/register, and
 * persists the resulting daemon_id + bv_d_ token + runtime ids into
 * `~/.beevibe/config.json`.
 *
 * Subsequent `beevibe-daemon start` reads the config; no token round-
 * trip per start.
 */

import { hostname, userInfo } from "node:os";
import { KNOWN_CLIS } from "@beevibe/core";
import { saveConfig, type DaemonConfig } from "./config.js";
import { detectClis } from "./detect-clis.js";

export interface SetupOptions {
  apiUrl: string;
  /** bv_u_ token of the user the daemon represents. */
  userToken: string;
  /** Override device_name (defaults to hostname). */
  deviceName?: string;
  /** Override the per-machine external_id (defaults to hostname). */
  externalId?: string;
  /**
   * Pre-fill detected CLIs (test injection). When unset, setup probes
   * PATH for known CLI names.
   */
  detectedClis?: Array<{ cli: string; cli_version?: string }>;
}

export async function runSetup(options: SetupOptions): Promise<DaemonConfig> {
  if (!/^https?:\/\//.test(options.apiUrl)) {
    throw new Error("--api must be an http(s) URL");
  }
  if (!options.userToken.startsWith("bv_u_")) {
    throw new Error("--user-token must start with bv_u_");
  }
  const externalId = options.externalId ?? hostname();
  const deviceName =
    options.deviceName ?? `${userInfo().username}@${hostname()}`;
  const runtimes = options.detectedClis ?? (await detectClis());
  if (runtimes.length === 0) {
    throw new Error(
      `No supported CLIs detected on PATH. beevibe currently looks for: ${KNOWN_CLIS.join(", ")}`,
    );
  }

  const res = await fetch(`${options.apiUrl}/runtime/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.userToken}`,
    },
    body: JSON.stringify({
      external_id: externalId,
      device_name: deviceName,
      runtimes,
    }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`/runtime/register failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    daemon_id: string;
    daemon_token: string;
    runtimes: Array<{ id: string; cli: string }>;
  };

  const config: DaemonConfig = {
    api_url: options.apiUrl,
    external_id: externalId,
    daemon_id: body.daemon_id,
    daemon_token: body.daemon_token,
    runtimes: body.runtimes,
  };
  saveConfig(config);
  return config;
}

