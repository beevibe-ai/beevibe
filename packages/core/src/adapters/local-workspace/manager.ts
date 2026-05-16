import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Agent } from "../../domain/agent.js";
import type { RuntimeRegistry, Workspace } from "../../ports/runtime.js";
import type { WorkspaceManager } from "../../ports/workspace.js";
import { syncSkills, tierFilterFor } from "../../services/skills/index.js";

/**
 * Filesystem-backed WorkspaceManager.
 *
 * Provisions `<workspaceRoot>/<agent_id>/` as the agent's persistent
 * sandbox AND writes `mcp-config.json` into it on first encounter. The
 * config contains the agent's bv_a_ API key + an `${BEEVIBE_SESSION_ID}`
 * placeholder that Claude CLI interpolates per-spawn.
 *
 * M9.3: also syncs tier-filtered SKILL.md files into the runtime's skills
 * discovery directory (`runtime.skillsDir(workspace)`). Sync is idempotent
 * via mtime+size diff; updates to a skill in the source dir propagate to
 * existing workspaces on the next ensureWorkspace call.
 *
 * Default root is `~/.beevibe/workspaces`. Directories are created with
 * mode 0o700 because they contain cloned repos and their credentials;
 * `mcp-config.json` is written with mode 0o600 because it contains an
 * unredacted bearer token.
 *
 * Idempotency: mcp-config.json is guarded by `existsSync` (no in-memory
 * state). Skill sync is mtime+size-based per-file diff. Re-running for
 * the same agent is safe and cheap.
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
  /**
   * Runtime registry — keyed by `agent.runtime_config.type`. ensureWorkspace
   * looks up the agent's declared runtime per-call to compute the skills
   * discovery directory inside the workspace (`runtime.skillsDir(workspace)`).
   * Throws if the agent's runtime type isn't in the registry.
   */
  runtimeRegistry: RuntimeRegistry;
  /**
   * Path to the canonical skills directory in the repo (e.g.
   * `<repo_root>/skills`). M9.3 syncs tier-filtered subsets from here into
   * each agent's workspace skills dir on every ensureWorkspace call.
   */
  skillsSourceDir: string;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly root: string;

  constructor(private config: LocalWorkspaceManagerConfig) {
    // `||` not `??` — an empty-string `workspaceRoot` (e.g. leaked from a
    // stray `WORKSPACE_ROOT=` line in .env via Bun's auto-load) is a bug
    // disguised as "configured": `?? ` would accept it and downstream
    // `join("", agent.id)` produces a relative path that spawn resolves
    // off the daemon's cwd. Force the homedir fallback for any falsy
    // value so the workspace always lands at a known absolute path.
    this.root = config.workspaceRoot || join(homedir(), ".beevibe", "workspaces");
    // Belt-and-suspenders: if someone constructs us with a relative root,
    // fail fast at construction time instead of mid-spawn.
    if (!isAbsolute(this.root)) {
      throw new Error(
        `LocalWorkspaceManager: workspaceRoot must be absolute, got "${this.root}"`,
      );
    }
  }

  async ensureWorkspace({ agent }: { agent: Agent }): Promise<Workspace> {
    const path = join(this.root, agent.id);
    // recursive: true creates parent dirs and is a no-op if the dir exists.
    // mode 0o700 applies only when the dir is created; existing dirs keep
    // their current permissions, which is the right semantic (idempotent).
    mkdirSync(path, { recursive: true, mode: 0o700 });

    if (!agent.api_key) {
      throw new Error(
        `Cannot write mcp-config.json for agent ${agent.id}: agent.api_key is missing`,
      );
    }
    const configPath = join(path, "mcp-config.json");
    const expected = buildMcpConfig(agent.api_key, this.config.mcpServerUrl);
    // Auto-refresh on drift: previously this was guarded by a bare
    // `existsSync` and a stale URL or rotated bv_a_ would persist until
    // the operator manually rm'd the file (documented but undiscoverable).
    // Compare-and-rewrite catches api_url switches (e.g. localhost → hosted
    // after deploy) and key rotations on the next ensureWorkspace call.
    const needsWrite =
      !existsSync(configPath) || readFileSync(configPath, "utf-8") !== expected;
    if (needsWrite) {
      writeFileSync(configPath, expected, { mode: 0o600 });
    }

    const workspace: Workspace = { path };

    // M9.3: sync tier-filtered skills into the agent's runtime-specific
    // discovery dir. Per-call runtime lookup keeps the manager agnostic
    // when multi-runtime support arrives. mtime+size diff makes this cheap
    // on the hot path (~50ms cold, <1ms warm); source skill edits
    // propagate on the next ensureWorkspace call.
    const runtime = this.config.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      throw new Error(
        `No runtime registered for agent ${agent.id} (runtime_config.type='${agent.runtime_config.type}')`,
      );
    }
    if (runtime.prepareWorkspace) {
      if (!agent.api_key) {
        throw new Error(
          `Cannot prepare workspace for agent ${agent.id}: agent.api_key is missing`,
        );
      }
      await runtime.prepareWorkspace({
        workspace,
        agentApiKey: agent.api_key,
        mcpServerUrl: this.config.mcpServerUrl,
      });
    }
    await syncSkills({
      sourceDir: this.config.skillsSourceDir,
      targetDir: runtime.skillsDir(workspace),
      filter: tierFilterFor(agent.hierarchy_level),
      namespacePrefix: "beevibe",
    });

    return workspace;
  }

  async removeWorkspace(workspace: Workspace): Promise<void> {
    rmSync(workspace.path, { recursive: true, force: true });
  }
}

/**
 * The mcp-config.json the spawner writes into each agent's workspace.
 * Exported so the daemon (`@beevibe/daemon`) can produce byte-identical
 * configs — the MCP server's parser sees one shape regardless of which
 * spawn path provisioned the workspace.
 *
 * `${BEEVIBE_SESSION_ID}` is a literal placeholder; the Claude CLI
 * interpolates from process env at config parse time, and the spawner
 * sets BEEVIBE_SESSION_ID on the subprocess env.
 */
export function buildMcpConfig(apiKey: string, mcpServerUrl: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          beevibe: {
            type: "http",
            url: mcpServerUrl,
            headers: {
              Authorization: `Bearer ${apiKey}`,
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
