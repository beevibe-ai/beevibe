import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../../ports/runtime.js";
import type { WorkspaceManager } from "../../ports/workspace.js";

/**
 * Filesystem-backed WorkspaceManager.
 *
 * Provisions `<workspaceRoot>/<agent_id>/` as the agent's persistent
 * sandbox. Default root is `~/.beevibe/workspaces`. Directories are
 * created with mode 0o700 because they will contain cloned repos and
 * their credentials (`.git/config`, possibly GitHub tokens).
 *
 * The adapter does nothing more than mkdir + rm — all git operations
 * (clone, worktree, commit, push, PR) are the agent's responsibility
 * via Claude Code's native Bash tool, guided by M9 skills.
 */
export interface LocalWorkspaceManagerConfig {
  /** Defaults to `~/.beevibe/workspaces`. */
  workspaceRoot?: string;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly root: string;

  constructor(config: LocalWorkspaceManagerConfig = {}) {
    this.root = config.workspaceRoot ?? join(homedir(), ".beevibe", "workspaces");
  }

  async ensureWorkspace(opts: { agent_id: string }): Promise<Workspace> {
    const path = join(this.root, opts.agent_id);
    // recursive: true creates parent dirs and is a no-op if the dir exists.
    // mode 0o700 applies only when the dir is created; existing dirs keep
    // their current permissions, which is the right semantic (idempotent).
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return { path };
  }

  async removeWorkspace(workspace: Workspace): Promise<void> {
    rmSync(workspace.path, { recursive: true, force: true });
  }
}
