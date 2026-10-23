/**
 * `beevibe-daemon start` — load config, open WS, poll, spawn on claim.
 * Holds the process until SIGINT/SIGTERM.
 */

import { join } from "node:path";
import { errorMessage } from "@beevibe/core";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import { createDefaultRuntimeRegistry } from "@beevibe/core/adapters/runtime-registry";
import { ApiClient } from "./api-client.js";
import { Claimer } from "./claimer.js";
import { getConfigRoot, loadConfig } from "./config.js";
import { log, warn } from "./logger.js";
import { syncSkillsCache } from "./skills-cache.js";
import { Supervisor } from "./supervisor.js";

export interface StartOptions {
  /** Dev-only `~/.beevibe` override; see config.ts:getConfigRoot. */
  configRoot?: string;
}

export async function runStart(options: StartOptions = {}): Promise<void> {
  const cfg = loadConfig(options.configRoot);
  if (!cfg) {
    throw new Error(
      "No daemon config found. Run `beevibe-daemon setup --api <url> --user-token <bv_u_…>` first.",
    );
  }

  const api = new ApiClient({
    apiUrl: cfg.api_url,
    daemonToken: cfg.daemon_token,
  });

  // Pull the latest skills bundle into <configRoot>/skills before any
  // workspace sync runs. Per-agent tier filter happens in
  // LocalWorkspaceManager.ensureWorkspace.
  const skillsSourceDir = await syncSkillsCache(api, options.configRoot).catch(
    (err: unknown) => {
      warn("[daemon] skills sync failed; continuing without skills:", errorMessage(err));
      return undefined;
    },
  );

  // WORKSPACE_ROOT env wins (CI / bespoke layouts); otherwise default
  // workspaces under the configRoot so a second daemon doesn't collide.
  const runtimeRegistry = createDefaultRuntimeRegistry();
  const workspaceManager = new LocalWorkspaceManager({
    mcpServerUrl: `${cfg.api_url}/mcp`,
    runtimeRegistry,
    skillsSourceDir: skillsSourceDir ?? "/dev/null",
    workspaceRoot:
      process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.length > 0
        ? process.env.WORKSPACE_ROOT
        : join(getConfigRoot(options.configRoot), "workspaces"),
  });

  const supervisor = new Supervisor();
  const claimer = new Claimer({
    api,
    supervisor,
    workspaceManager,
    runtimeRegistry,
    runtimeIds: cfg.runtimes.map((r) => r.id),
  });
  claimer.start();
  log(
    `[daemon] started (${cfg.daemon_id} → ${cfg.api_url}, ${cfg.runtimes.length} runtime(s))`,
  );

  let stopped = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`[daemon] received ${signal}; stopping`);
    await claimer.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Safety net for any fetch/promise that leaks past a call-site catch.
  // Per-site try/catch is the correct fix; this exists so a single missed
  // catch doesn't take the whole daemon down — the claimer loop is
  // self-healing, so logging and continuing is the right behavior under
  // Node 20+'s default `--unhandled-rejections=throw`.
  process.on("unhandledRejection", (reason) => {
    warn("[daemon] unhandledRejection (continuing):", errorMessage(reason));
  });

  // Hold the process open. The `setInterval` in claimer keeps the event
  // loop alive on its own, but make this explicit so an empty
  // run-then-exit isn't possible.
  await new Promise<void>(() => undefined);
}
