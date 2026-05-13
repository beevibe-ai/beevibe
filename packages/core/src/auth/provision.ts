import type { Agent } from "../domain/agent.js";
import type { CoreMemoryBlock } from "../domain/core-memory.js";
import type { Person } from "../domain/person.js";
import type { AgentRepository, NewAgent } from "../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../ports/core-memory-repo.js";
import type { NewPerson, PersonRepository } from "../ports/person-repo.js";
import { generateAgentApiKey, generateUserApiKey } from "./api-key.js";

export interface ProvisionAgentDeps {
  agentRepo: AgentRepository;
  coreMemoryRepo: CoreMemoryBlockRepository;
}

export type ProvisionAgentInput = Omit<NewAgent, "api_key">;

export interface ProvisionAgentResult {
  agent: Agent;
  blocks: CoreMemoryBlock[];
  /** Plaintext key, returned once. Also persisted on agent.api_key for v1. */
  apiKey: string;
}

/**
 * Bring a new agent into existence: generate its bv_a_ key, insert the
 * agent row, and seed the default core-memory blocks for its hierarchy
 * level. Returns the plaintext key alongside the agent.
 *
 * Not transactional: if `initDefaults` throws after `agentRepo.create`,
 * the agent row exists without its default blocks. Accepted for v1;
 * proper fix requires threading a PoolClient through both repos.
 */
export async function provisionAgent(
  deps: ProvisionAgentDeps,
  input: ProvisionAgentInput,
): Promise<ProvisionAgentResult> {
  const apiKey = generateAgentApiKey();
  // Default review_policy to 'auto_done' so updateProgress(done) closes
  // tasks without a human-review hop. Users can flip to 'require_human'
  // per-agent via POST /agent/:id/review-policy when they want a gate.
  const agent = await deps.agentRepo.create({
    ...input,
    review_policy: input.review_policy ?? "auto_done",
    api_key: apiKey,
  });
  const blocks = await deps.coreMemoryRepo.initDefaults(
    agent.id,
    agent.hierarchy_level,
  );
  return { agent, blocks, apiKey };
}

export interface ProvisionUserDeps {
  personRepo: PersonRepository;
}

export type ProvisionUserInput = Omit<NewPerson, "api_key">;

export interface ProvisionUserResult {
  person: Person;
  /** Plaintext key, returned once. Also persisted on person.api_key for v1. */
  apiKey: string;
}

/**
 * Bring a new human user into existence: generate their bv_u_ key and
 * insert the person row with the key set. Atomic — single INSERT.
 *
 * Key rotation is out of scope for v1; callers can update the key
 * directly via `personRepo.update(id, { api_key })` if needed.
 */
export async function provisionUser(
  deps: ProvisionUserDeps,
  input: ProvisionUserInput,
): Promise<ProvisionUserResult> {
  const apiKey = generateUserApiKey();
  const person = await deps.personRepo.create({ ...input, api_key: apiKey });
  return { person, apiKey };
}
