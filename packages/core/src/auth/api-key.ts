import { customAlphabet } from "nanoid";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { PersonRepository } from "../ports/person-repo.js";
import type { ResolvedCaller } from "./caller.js";
import { findUserAgent } from "./find-user-agent.js";

const KEY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nanoid24 = customAlphabet(KEY_ALPHABET, 24);

export const AGENT_KEY_PREFIX = "bv_a_";
export const USER_KEY_PREFIX = "bv_u_";

/** Generate a bv_a_-prefixed agent API key. One per agent. Plaintext for v1. */
export function generateAgentApiKey(): string {
  return `${AGENT_KEY_PREFIX}${nanoid24()}`;
}

/** Generate a bv_u_-prefixed human API key. One per person. Plaintext for v1. */
export function generateUserApiKey(): string {
  return `${USER_KEY_PREFIX}${nanoid24()}`;
}

export interface LookupApiKeyDeps {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
}

/**
 * Resolve a bearer token to a caller identity. Dispatches on the key prefix:
 *   - bv_a_... → look up the agent directly on `agent.api_key`.
 *   - bv_u_... → look up the person on `person.api_key`, then resolve their
 *                top-level (team > org) agent via findUserAgent.
 *
 * Returns `undefined` for null/empty/malformed tokens without touching the DB.
 * Returns `undefined` for a human token whose person has no primary agent —
 * they have no agent to act as.
 */
export async function lookupApiKey(
  deps: LookupApiKeyDeps,
  token: string,
): Promise<ResolvedCaller | undefined> {
  if (!token) return undefined;

  if (token.startsWith(AGENT_KEY_PREFIX)) {
    const agent = await deps.agentRepo.findByApiKey(token);
    if (!agent) return undefined;
    return {
      source: "agent",
      agentId: agent.id,
      hierarchyLevel: agent.hierarchy_level,
    };
  }

  if (token.startsWith(USER_KEY_PREFIX)) {
    const person = await deps.personRepo.findByApiKey(token);
    if (!person) return undefined;
    const primary = await findUserAgent(deps.agentRepo, person.id);
    if (!primary) return undefined;
    return {
      source: "human",
      agentId: primary.agentId,
      hierarchyLevel: primary.hierarchyLevel,
      personId: person.id,
    };
  }

  return undefined;
}
