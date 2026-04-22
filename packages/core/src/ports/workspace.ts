import type { Workspace } from "./runtime.js";

/**
 * Per-agent workspace provisioner.
 *
 * The platform's entire filesystem responsibility for agent execution:
 * give the agent a directory it owns, and remove it when the agent is
 * deleted. Cloning repos, creating git worktrees for parallel tasks,
 * committing, and opening PRs are all the agent's responsibility.
 *
 * Scope: per-AGENT, not per-task. The workspace persists across tasks so
 * repo clones and cached state accumulate naturally. Revision sessions
 * re-enter the same dir and see their prior state.
 */
export interface WorkspaceManager {
  /**
   * Ensure a workspace directory exists for the given agent and return it.
   * Idempotent: calling twice for the same agent_id is a no-op; existing
   * files inside are preserved.
   */
  ensureWorkspace(opts: { agent_id: string }): Promise<Workspace>;

  /**
   * Remove a workspace and everything inside it. Called when an agent is
   * deleted — never per-task. No-op if the dir doesn't exist.
   */
  removeWorkspace(workspace: Workspace): Promise<void>;
}
