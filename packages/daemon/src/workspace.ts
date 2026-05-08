/**
 * Provision a per-agent workspace under `~/.beevibe/workspaces/<agent_id>/`
 * and write the `mcp-config.json` Claude reads to talk back to the api
 * server's /mcp surface.
 *
 * Mirrors `LocalWorkspaceManager.ensureWorkspace` from @beevibe/core but
 * runs daemon-side, so `runtimeRegistry` and skills sync — both api-side
 * concerns — aren't pulled in. Skills come from a future
 * GET /runtime/skills endpoint (Phase 4 daemon hardening).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Lazy so tests can stub HOME between calls. */
export function workspaceRoot(): string {
  return join(homedir(), ".beevibe", "workspaces");
}

export interface DaemonWorkspace {
  /** Absolute path to the workspace root for this agent. */
  path: string;
}

export interface ProvisionInput {
  agentId: string;
  agentApiKey: string;
  mcpServerUrl: string;
}

export function provisionWorkspace(input: ProvisionInput): DaemonWorkspace {
  const dir = join(workspaceRoot(), input.agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfgPath = join(dir, "mcp-config.json");
  if (!existsSync(cfgPath)) {
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          mcpServers: {
            beevibe: {
              type: "http",
              url: input.mcpServerUrl,
              headers: {
                Authorization: `Bearer ${input.agentApiKey}`,
                "X-Beevibe-Session": "${BEEVIBE_SESSION_ID}",
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  return { path: dir };
}
