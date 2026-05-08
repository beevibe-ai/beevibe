/**
 * `beevibe-daemon start` — load config, open WS, poll, spawn on claim.
 * Holds the process until SIGINT/SIGTERM.
 */

import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import { createDefaultRuntimeRegistry } from "@beevibe/core/adapters/runtime-registry";
import { ApiClient } from "./api-client.js";
import { Claimer } from "./claimer.js";
import { loadConfig } from "./config.js";
import { syncSkillsCache } from "./skills-cache.js";
import { Supervisor } from "./supervisor.js";

export async function runStart(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error(
      "No daemon config found. Run `beevibe-daemon setup --api <url> --user-token <bv_u_…>` first.",
    );
  }

  const api = new ApiClient({
    apiUrl: cfg.api_url,
    daemonToken: cfg.daemon_token,
  });

  // Pull the latest skills bundle into ~/.beevibe/skills before any
  // workspace sync runs. Per-agent tier filter happens in
  // LocalWorkspaceManager.ensureWorkspace.
  const skillsSourceDir = await syncSkillsCache(api).catch((err: unknown) => {
    console.warn(
      "[daemon] skills sync failed; continuing without skills:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  });

  const runtimeRegistry = createDefaultRuntimeRegistry();
  const workspaceManager = new LocalWorkspaceManager({
    mcpServerUrl: `${cfg.api_url}/mcp`,
    runtimeRegistry,
    skillsSourceDir: skillsSourceDir ?? "/dev/null",
    // env override lets tests / dev override ~/.beevibe/workspaces.
    workspaceRoot: process.env.WORKSPACE_ROOT,
  });

  const supervisor = new Supervisor();
  const claimer = new Claimer({
    api,
    supervisor,
    workspaceManager,
    runtimeIds: cfg.runtimes.map((r) => r.id),
  });
  claimer.start();
  console.log(
    `[daemon] started (${cfg.daemon_id} → ${cfg.api_url}, ${cfg.runtimes.length} runtime(s))`,
  );

  let stopped = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.log(`[daemon] received ${signal}; stopping`);
    await claimer.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Hold the process open. The `setInterval` in claimer keeps the event
  // loop alive on its own, but make this explicit so an empty
  // run-then-exit isn't possible.
  await new Promise<void>(() => undefined);
}
