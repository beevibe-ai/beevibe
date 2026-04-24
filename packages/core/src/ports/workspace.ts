import type { Agent } from "../domain/agent.js";
import type { Workspace } from "./runtime.js";

/**
 * Per-agent workspace provisioner.
 *
 * The platform's entire filesystem responsibility for agent execution:
 * give the agent a directory it owns, remove it when the agent is deleted,
 * and make sure the `mcp-config.json` the spawned CLI needs is on disk.
 * Cloning repos, creating git worktrees for parallel tasks, committing, and
 * opening PRs are all the agent's responsibility.
 *
 * Scope: per-AGENT, not per-task. The workspace persists across tasks so
 * repo clones and cached state accumulate naturally. Revision sessions
 * re-enter the same dir and see their prior state.
 *
 * Why the port takes `agent` (not just `agent_id`): adapters may need to
 * write agent-scoped artifacts into the dir (e.g. `LocalWorkspaceManager`
 * writes a `mcp-config.json` containing the agent's bv_a_ API key).
 * Requiring the caller to provide the resolved Agent keeps adapters
 * independent of the AgentRepository.
 */
export interface WorkspaceManager {
  /**
   * Ensure `agent`'s workspace dir exists and its expected artifacts
   * (e.g. `mcp-config.json`) are on disk. Idempotent: calling twice for
   * the same agent is safe; existing files inside are preserved.
   */
  ensureWorkspace(opts: { agent: Agent }): Promise<Workspace>;

  /**
   * Remove a workspace and everything inside it. Called when an agent is
   * deleted — never per-task. No-op if the dir doesn't exist.
   */
  removeWorkspace(workspace: Workspace): Promise<void>;
}
