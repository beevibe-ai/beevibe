import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../../domain/agent.js";
import type { Workspace } from "../../ports/runtime.js";
import type { WorkspaceManager } from "../../ports/workspace.js";

/**
 * Filesystem-backed WorkspaceManager.
 *
 * Provisions `<workspaceRoot>/<agent_id>/` as the agent's persistent
 * sandbox AND writes `mcp-config.json` into it on first encounter. The
 * config contains the agent's bv_a_ API key + an `${BEEVIBE_SESSION_ID}`
 * placeholder that Claude CLI interpolates per-spawn.
 *
 * Default root is `~/.beevibe/workspaces`. Directories are created with
 * mode 0o700 because they contain cloned repos and their credentials;
 * `mcp-config.json` is written with mode 0o600 because it contains an
 * unredacted bearer token.
 *
 * Idempotency comes from `existsSync` on the config file — no in-memory
 * state. After API key rotation or `mcpServerUrl` change, the existing
 * file persists until an operator deletes it (or the whole workspace).
 * Key rotation is deliberate and infrequent; the cost of this simplicity
 * is that operators must `rm` the file to force re-provisioning.
 */
export interface LocalWorkspaceManagerConfig {
  /** Defaults to `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
  /**
   * MCP server URL baked into each agent's `mcp-config.json`. Required:
   * the file cannot be written without it. Typically sourced from
   * `BEEVIBE_MCP_SERVER_URL` via the executor/MCP-server bootstrap.
   */
  mcpServerUrl: string;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly root: string;

  constructor(private config: LocalWorkspaceManagerConfig) {
    this.root = config.workspaceRoot ?? join(homedir(), ".beevibe", "workspaces");
  }

  async ensureWorkspace({ agent }: { agent: Agent }): Promise<Workspace> {
    const path = join(this.root, agent.id);
    // recursive: true creates parent dirs and is a no-op if the dir exists.
    // mode 0o700 applies only when the dir is created; existing dirs keep
    // their current permissions, which is the right semantic (idempotent).
    mkdirSync(path, { recursive: true, mode: 0o700 });

    const configPath = join(path, "mcp-config.json");
    if (!existsSync(configPath)) {
      if (!agent.api_key) {
        throw new Error(
          `Cannot write mcp-config.json for agent ${agent.id}: agent.api_key is missing`,
        );
      }
      writeFileSync(configPath, buildMcpConfig(agent.api_key, this.config.mcpServerUrl), {
        mode: 0o600,
      });
    }

    return { path };
  }

  async removeWorkspace(workspace: Workspace): Promise<void> {
    rmSync(workspace.path, { recursive: true, force: true });
  }
}

function buildMcpConfig(apiKey: string, mcpServerUrl: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          beevibe: {
            type: "http",
            url: mcpServerUrl,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              // Literal placeholder — Claude CLI interpolates from process env
              // at config parse time; AgentSession sets BEEVIBE_SESSION_ID on
              // the spawned subprocess env. Verified via runtime probe.
              "X-Beevibe-Session": "${BEEVIBE_SESSION_ID}",
            },
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}
