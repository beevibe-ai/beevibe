/**
 * Provision a per-agent workspace under `~/.beevibe/workspaces/<agent_id>/`
 * and write `mcp-config.json` so the spawned CLI talks back to the api
 * server's /mcp surface. The config shape comes from @beevibe/core's
 * `buildMcpConfig` so the daemon and the (api-side) `LocalWorkspaceManager`
 * produce byte-identical output. Skills sync remains an api-side concern
 * for now — daemon-side skills come with the GET /runtime/skills endpoint
 * (Phase 4 daemon hardening).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMcpConfig } from "@beevibe/core/adapters/local-workspace";

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
  // Always rewrite — token rotations from re-register need to land
  // immediately. Idempotent under concurrent claims because every
  // writer produces the same bytes.
  writeFileSync(
    join(dir, "mcp-config.json"),
    buildMcpConfig(input.agentApiKey, input.mcpServerUrl),
    { mode: 0o600 },
  );
  return { path: dir };
}
