import type { Agent } from "../domain/agent.js";
import type { CoreMemoryBlock } from "../domain/core-memory.js";
import type { AgentRepository, NewAgent } from "../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../ports/core-memory-repo.js";

export interface AgentServiceDeps {
  agentRepo: AgentRepository;
  coreMemoryRepo: CoreMemoryBlockRepository;
}

export interface AgentCreationResult {
  agent: Agent;
  blocks: CoreMemoryBlock[];
}

/**
 * Thin orchestration around agent creation. Ensures a new agent always has
 * the default core-memory blocks for its hierarchy level.
 *
 * Known limitation (M3): the two writes are not transactional across the
 * two repositories. If `initDefaults` fails after `agentRepo.create`, the
 * agent exists without blocks. Future cleanup: wrap in a `pool.connect()`
 * transaction shared between the two repos.
 */
export class AgentService {
  constructor(private deps: AgentServiceDeps) {}

  async create(input: NewAgent): Promise<AgentCreationResult> {
    const agent = await this.deps.agentRepo.create(input);
    const blocks = await this.deps.coreMemoryRepo.initDefaults(
      agent.id,
      agent.hierarchy_level,
    );
    return { agent, blocks };
  }
}
