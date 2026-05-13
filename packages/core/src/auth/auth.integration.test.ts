/**
 * Auth module, integration-tested against a real Postgres DB. DB-only —
 * no LLM, no CLI. Runs as part of the standard `pnpm test` cycle when
 * DATABASE_URL_TEST is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAgentRepository } from "../adapters/postgres/agent-repo.js";
import type { Pool } from "../adapters/postgres/client.js";
import { PostgresCoreMemoryRepository } from "../adapters/postgres/core-memory-repo.js";
import { PostgresDaemonRepository } from "../adapters/postgres/daemon-repo.js";
import { PostgresPersonRepository } from "../adapters/postgres/person-repo.js";
import { createTestPool, truncateAll } from "../test-helpers.js";
import { DEFAULT_RUNTIME_CONFIG } from "../domain/agent.js";
import { agentId, daemonId, personId } from "../domain/ids.js";
import {
  generateDaemonApiKey,
  hashDaemonToken,
  lookupApiKey,
} from "./api-key.js";
import { findUserAgent } from "./find-user-agent.js";
import { provisionAgent, provisionUser } from "./provision.js";

describe("auth — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let daemonRepo: PostgresDaemonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let deps: {
    agentRepo: PostgresAgentRepository;
    personRepo: PostgresPersonRepository;
    daemonRepo: PostgresDaemonRepository;
  };

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    daemonRepo = new PostgresDaemonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    deps = { agentRepo, personRepo, daemonRepo };
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeAlice() {
    return provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
  }

  async function makeTeamAgentFor(ownerId: string) {
    return provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: ownerId,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
  }

  it("provisionUser mints a bv_u_ key and stores it on the person row", async () => {
    const alice = await makeAlice();
    expect(alice.apiKey).toMatch(/^bv_u_[0-9A-Za-z]{24}$/);
    expect(alice.person.api_key).toBe(alice.apiKey);
    const fetched = await personRepo.findByApiKey(alice.apiKey);
    expect(fetched?.id).toBe(alice.person.id);
  });

  it("provisionAgent mints a bv_a_ key, stores it, and seeds 5 default blocks", async () => {
    const alice = await makeAlice();
    const team = await makeTeamAgentFor(alice.person.id);

    expect(team.apiKey).toMatch(/^bv_a_[0-9A-Za-z]{24}$/);
    expect(team.agent.api_key).toBe(team.apiKey);
    expect(team.blocks).toHaveLength(5);

    const fetched = await agentRepo.findByApiKey(team.apiKey);
    expect(fetched?.id).toBe(team.agent.id);
  });

  it("lookupApiKey(agentKey) → source='agent' with correct agentId + level", async () => {
    const alice = await makeAlice();
    const team = await makeTeamAgentFor(alice.person.id);

    const caller = await lookupApiKey(deps, team.apiKey);
    expect(caller).toEqual({
      source: "agent",
      agentId: team.agent.id,
      hierarchyLevel: "team",
    });
  });

  it("lookupApiKey(userKey) → source='human' resolving to the person's team agent", async () => {
    const alice = await makeAlice();
    const team = await makeTeamAgentFor(alice.person.id);

    const caller = await lookupApiKey(deps, alice.apiKey);
    expect(caller).toEqual({
      source: "human",
      agentId: team.agent.id,
      hierarchyLevel: "team",
      personId: alice.person.id,
    });
  });

  it("findUserAgent prefers team over org for the same owner", async () => {
    const alice = await makeAlice();
    const team = await makeTeamAgentFor(alice.person.id);
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Org Agent",
        owner_id: alice.person.id,
        hierarchy_level: "org",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const primary = await findUserAgent(agentRepo, alice.person.id);
    expect(primary?.agentId).toBe(team.agent.id);
    expect(primary?.hierarchyLevel).toBe("team");

    // And the human-key lookup should still route to the team agent too.
    const human = await lookupApiKey(deps, alice.apiKey);
    expect(human?.source === "human" && human.agentId).toBe(team.agent.id);
  });

  it("findUserAgent falls back to org when no team agent exists", async () => {
    const alice = await makeAlice();
    const org = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Org Agent",
        owner_id: alice.person.id,
        hierarchy_level: "org",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const primary = await findUserAgent(agentRepo, alice.person.id);
    expect(primary?.agentId).toBe(org.agent.id);
    expect(primary?.hierarchyLevel).toBe("org");
  });

  it("lookupApiKey returns undefined for empty, malformed, and unknown tokens", async () => {
    expect(await lookupApiKey(deps, "")).toBeUndefined();
    expect(await lookupApiKey(deps, "random-not-a-key")).toBeUndefined();
    expect(await lookupApiKey(deps, "bv_a_definitely_not_real")).toBeUndefined();
    expect(await lookupApiKey(deps, "bv_u_definitely_not_real")).toBeUndefined();
  });

  it("lookupApiKey returns undefined for a human whose person exists but has no primary agent", async () => {
    const bob = await provisionUser(
      { personRepo },
      { id: personId(), name: "Bob", email: "bob@example.com" },
    );
    // person row + key exist…
    expect((await personRepo.findByApiKey(bob.apiKey))?.id).toBe(bob.person.id);
    // …but no team/org agent, so auth refuses.
    expect(await lookupApiKey(deps, bob.apiKey)).toBeUndefined();
  });

  it("lookupApiKey(daemonKey) → source='daemon' with daemonId + ownerPersonId", async () => {
    const alice = await makeAlice();
    const token = generateDaemonApiKey();
    const id = daemonId();
    await daemonRepo.create({
      id,
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });

    const caller = await lookupApiKey(deps, token);
    expect(caller).toEqual({
      source: "daemon",
      daemonId: id,
      ownerPersonId: alice.person.id,
    });
  });

  it("revoked daemon tokens stop resolving", async () => {
    const alice = await makeAlice();
    const token = generateDaemonApiKey();
    const id = daemonId();
    await daemonRepo.create({
      id,
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });
    expect(await lookupApiKey(deps, token)).toBeDefined();
    await daemonRepo.revoke(id);
    expect(await lookupApiKey(deps, token)).toBeUndefined();
  });

  it("person.api_key UNIQUE prevents two users from sharing a key (provisionUser collisions bubble)", async () => {
    // Generated keys are random, so the only way to get a collision is a manual duplicate.
    // We assert the constraint is live by trying a direct update.
    const a = await provisionUser(
      { personRepo },
      { id: personId(), name: "A" },
    );
    const b = await provisionUser(
      { personRepo },
      { id: personId(), name: "B" },
    );
    await expect(
      personRepo.update(b.person.id, { api_key: a.apiKey }),
    ).rejects.toThrow();
  });
});
