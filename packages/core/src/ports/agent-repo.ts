import type { Agent, HierarchyLevel } from "../domain/agent.js";

export type NewAgent = Omit<Agent, "created_at" | "updated_at">;

export type AgentPatch = Partial<Omit<Agent, "id" | "created_at" | "updated_at">>;

export interface AgentRepository {
  findById(id: string): Promise<Agent | undefined>;

  findByApiKey(apiKey: string): Promise<Agent | undefined>;

  findByOwnerId(ownerId: string): Promise<Agent[]>;

  /**
   * Find the user's primary agent — team-level if it exists, otherwise org-level.
   * IC agents are intentionally excluded (they're subordinates, not entry points).
   * Replaces the old `findUserAgent` function.
   */
  findTopLevelForOwner(ownerId: string): Promise<Agent | undefined>;

  findSubordinates(parentAgentId: string): Promise<Agent[]>;

  /** Peers = same parent_agent_id AND same hierarchy_level. */
  findPeers(agentId: string): Promise<Agent[]>;

  /**
   * Find the agent's direct parent in the hierarchy. Returns `undefined` for
   * top-level agents (no parent). Used by the `find_up` MCP tool and by
   * `revise_task` authorization (M6.4) to verify the parent-child relationship
   * before letting a parent revise a subordinate's task.
   */
  findParent(agentId: string): Promise<Agent | undefined>;

  /** All agents at a given hierarchy level (e.g., all team agents under an org). */
  findByLevel(level: HierarchyLevel): Promise<Agent[]>;

  create(input: NewAgent): Promise<Agent>;

  update(id: string, patch: AgentPatch): Promise<Agent>;

  delete(id: string): Promise<void>;
}
