import type { HierarchyLevel } from "../domain/agent.js";
import type { AgentRepository } from "../ports/agent-repo.js";

export interface UserAgent {
  agentId: string;
  hierarchyLevel: HierarchyLevel;
}

/**
 * Resolve a person to their primary agent — team-level if one exists,
 * otherwise org-level. IC agents are intentionally excluded; they're
 * subordinates, not runtime entry points.
 *
 * Returns `undefined` when the person owns no team or org agent. Callers
 * typically treat that as "not authorized for a runtime session".
 */
export async function findUserAgent(
  agentRepo: AgentRepository,
  personId: string,
): Promise<UserAgent | undefined> {
  const agent = await agentRepo.findTopLevelForOwner(personId);
  if (!agent) return undefined;
  return { agentId: agent.id, hierarchyLevel: agent.hierarchy_level };
}
