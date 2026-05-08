import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { DaemonRepository } from "../ports/daemon-repo.js";
import type { PersonRepository } from "../ports/person-repo.js";
import type { ResolvedCaller } from "./caller.js";
import { findUserAgent } from "./find-user-agent.js";

const KEY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nanoid24 = customAlphabet(KEY_ALPHABET, 24);

export const AGENT_KEY_PREFIX = "bv_a_";
export const USER_KEY_PREFIX = "bv_u_";
export const DAEMON_KEY_PREFIX = "bv_d_";

/** Generate a bv_a_-prefixed agent API key. One per agent. Plaintext for v1. */
export function generateAgentApiKey(): string {
  return `${AGENT_KEY_PREFIX}${nanoid24()}`;
}

/** Generate a bv_u_-prefixed human API key. One per person. Plaintext for v1. */
export function generateUserApiKey(): string {
  return `${USER_KEY_PREFIX}${nanoid24()}`;
}

/**
 * Generate a bv_d_-prefixed daemon API key. One per daemon row, shown to the
 * user once at register-time and stored only on disk on their machine. The
 * server stores `hashDaemonToken(token)` so a DB leak doesn't compromise
 * tokens. Tokens have ~144 bits of entropy (24 chars × log2(62)).
 */
export function generateDaemonApiKey(): string {
  return `${DAEMON_KEY_PREFIX}${nanoid24()}`;
}

/**
 * Deterministic hash for daemon tokens. SHA-256 is sufficient for
 * high-entropy tokens (preimage resistance protects the plaintext) and
 * lets the daemon table support an indexed lookup by hash. Argon2 would
 * defeat indexed lookup; the high entropy of the token already makes
 * brute-force infeasible.
 */
export function hashDaemonToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface LookupApiKeyDeps {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  /** Optional — only required if the surface accepts bv_d_ daemon tokens. */
  daemonRepo?: DaemonRepository;
}

/**
 * Resolve a bearer token to a caller identity. Dispatches on the key prefix:
 *   - bv_a_... → look up the agent directly on `agent.api_key`.
 *   - bv_u_... → look up the person on `person.api_key`, then resolve their
 *                top-level (team > org) agent via findUserAgent.
 *   - bv_d_... → hash the token, look up the daemon by hash. Daemons have no
 *                associated agent — `/runtime/*` routes accept this caller.
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

  if (token.startsWith(DAEMON_KEY_PREFIX)) {
    if (!deps.daemonRepo) return undefined;
    const daemon = await deps.daemonRepo.findByTokenHash(hashDaemonToken(token));
    if (!daemon) return undefined;
    return {
      source: "daemon",
      daemonId: daemon.id,
      ownerPersonId: daemon.owner_person_id,
    };
  }

  return undefined;
}
