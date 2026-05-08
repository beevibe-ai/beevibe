import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { Daemon } from "../domain/daemon.js";
import type { Person } from "../domain/person.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { DaemonRepository } from "../ports/daemon-repo.js";
import type { PersonRepository } from "../ports/person-repo.js";
import {
  AGENT_KEY_PREFIX,
  DAEMON_KEY_PREFIX,
  USER_KEY_PREFIX,
  generateAgentApiKey,
  generateDaemonApiKey,
  generateUserApiKey,
  hashDaemonToken,
  lookupApiKey,
} from "./api-key.js";
import {
  makeAgentRepoFake,
  makeDaemonRepoFake,
  makePersonRepoFake,
} from "./test-fakes.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "Test",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude", model: "claude-opus-4-7" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "person_1",
    name: "Alice",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeDaemon(overrides: Partial<Daemon> = {}): Daemon {
  return {
    id: "dmn_1",
    owner_person_id: "person_1",
    external_id: "macbook-pro",
    device_name: "MacBook Pro",
    token_hash: "deadbeef",
    created_at: new Date(),
    ...overrides,
  };
}

let agentRepo: AgentRepository;
let personRepo: PersonRepository;
let daemonRepo: DaemonRepository;

beforeEach(() => {
  agentRepo = makeAgentRepoFake();
  personRepo = makePersonRepoFake();
  daemonRepo = makeDaemonRepoFake();
});

describe("generateAgentApiKey", () => {
  it("starts with the agent prefix and has 24 chars of entropy", () => {
    const key = generateAgentApiKey();
    expect(key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^bv_a_[0-9A-Za-z]{24}$/);
  });

  it("produces unique keys on each call", () => {
    expect(generateAgentApiKey()).not.toBe(generateAgentApiKey());
  });
});

describe("generateUserApiKey", () => {
  it("starts with the user prefix and has 24 chars of entropy", () => {
    const key = generateUserApiKey();
    expect(key.startsWith(USER_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^bv_u_[0-9A-Za-z]{24}$/);
  });

  it("agent and user keys have distinct, non-overlapping prefixes", () => {
    expect(generateAgentApiKey().startsWith(USER_KEY_PREFIX)).toBe(false);
    expect(generateUserApiKey().startsWith(AGENT_KEY_PREFIX)).toBe(false);
  });
});

describe("lookupApiKey — malformed input", () => {
  it("returns undefined for empty string without hitting the DB", async () => {
    const out = await lookupApiKey({ agentRepo, personRepo }, "");
    expect(out).toBeUndefined();
    expect(agentRepo.findByApiKey).not.toHaveBeenCalled();
    expect(personRepo.findByApiKey).not.toHaveBeenCalled();
  });

  it("returns undefined for a token with neither bv_a_ nor bv_u_ prefix", async () => {
    const out = await lookupApiKey({ agentRepo, personRepo }, "not-a-bv-key");
    expect(out).toBeUndefined();
    expect(agentRepo.findByApiKey).not.toHaveBeenCalled();
    expect(personRepo.findByApiKey).not.toHaveBeenCalled();
  });

  it("returns undefined for a bare 'bv_' prefix", async () => {
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_nope");
    expect(out).toBeUndefined();
  });
});

describe("lookupApiKey — bv_a_ (agent) path", () => {
  it("returns a source='agent' caller on a hit", async () => {
    vi.mocked(agentRepo.findByApiKey).mockResolvedValue(
      makeAgent({ id: "agent_42", hierarchy_level: "org" }),
    );
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_a_abc");
    expect(out).toEqual({
      source: "agent",
      agentId: "agent_42",
      hierarchyLevel: "org",
    });
    expect(agentRepo.findByApiKey).toHaveBeenCalledWith("bv_a_abc");
    expect(personRepo.findByApiKey).not.toHaveBeenCalled();
  });

  it("returns undefined when no agent matches the key", async () => {
    vi.mocked(agentRepo.findByApiKey).mockResolvedValue(undefined);
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_a_ghost");
    expect(out).toBeUndefined();
  });
});

describe("lookupApiKey — bv_u_ (human) path", () => {
  it("returns a source='human' caller pointing at the person's primary agent", async () => {
    vi.mocked(personRepo.findByApiKey).mockResolvedValue(
      makePerson({ id: "person_alice" }),
    );
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      makeAgent({ id: "agent_team_alice", hierarchy_level: "team" }),
    );
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_u_abc");
    expect(out).toEqual({
      source: "human",
      agentId: "agent_team_alice",
      hierarchyLevel: "team",
      personId: "person_alice",
    });
    expect(personRepo.findByApiKey).toHaveBeenCalledWith("bv_u_abc");
    expect(agentRepo.findTopLevelForOwner).toHaveBeenCalledWith("person_alice");
  });

  it("returns undefined when no person matches the key", async () => {
    vi.mocked(personRepo.findByApiKey).mockResolvedValue(undefined);
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_u_ghost");
    expect(out).toBeUndefined();
    expect(agentRepo.findTopLevelForOwner).not.toHaveBeenCalled();
  });

  it("returns undefined when the person has no team/org agent", async () => {
    vi.mocked(personRepo.findByApiKey).mockResolvedValue(makePerson());
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_u_orphan");
    expect(out).toBeUndefined();
  });

  it("propagates org level when the person's only primary agent is org-level", async () => {
    vi.mocked(personRepo.findByApiKey).mockResolvedValue(makePerson());
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      makeAgent({ hierarchy_level: "org" }),
    );
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_u_org");
    expect(out?.hierarchyLevel).toBe("org");
  });
});

describe("generateDaemonApiKey + hashDaemonToken", () => {
  it("starts with the daemon prefix and has 24 chars of entropy", () => {
    const key = generateDaemonApiKey();
    expect(key.startsWith(DAEMON_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^bv_d_[0-9A-Za-z]{24}$/);
  });

  it("hashDaemonToken is deterministic and avalanches on input changes", () => {
    const a = hashDaemonToken("bv_d_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = hashDaemonToken("bv_d_aaaaaaaaaaaaaaaaaaaaaaaa");
    const c = hashDaemonToken("bv_d_aaaaaaaaaaaaaaaaaaaaaaab");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("daemon prefix is non-overlapping with agent and user prefixes", () => {
    expect(generateDaemonApiKey().startsWith(AGENT_KEY_PREFIX)).toBe(false);
    expect(generateDaemonApiKey().startsWith(USER_KEY_PREFIX)).toBe(false);
    expect(generateAgentApiKey().startsWith(DAEMON_KEY_PREFIX)).toBe(false);
    expect(generateUserApiKey().startsWith(DAEMON_KEY_PREFIX)).toBe(false);
  });
});

describe("lookupApiKey — bv_d_ (daemon) path", () => {
  it("returns a source='daemon' caller on a hash hit", async () => {
    vi.mocked(daemonRepo.findByTokenHash).mockResolvedValue(
      makeDaemon({ id: "dmn_42", owner_person_id: "person_zhe" }),
    );
    const out = await lookupApiKey(
      { agentRepo, personRepo, daemonRepo },
      "bv_d_token123",
    );
    expect(out).toEqual({
      source: "daemon",
      daemonId: "dmn_42",
      ownerPersonId: "person_zhe",
    });
    expect(daemonRepo.findByTokenHash).toHaveBeenCalledWith(
      hashDaemonToken("bv_d_token123"),
    );
    expect(agentRepo.findByApiKey).not.toHaveBeenCalled();
    expect(personRepo.findByApiKey).not.toHaveBeenCalled();
  });

  it("returns undefined when no daemon matches the token hash", async () => {
    vi.mocked(daemonRepo.findByTokenHash).mockResolvedValue(undefined);
    const out = await lookupApiKey(
      { agentRepo, personRepo, daemonRepo },
      "bv_d_ghost",
    );
    expect(out).toBeUndefined();
  });

  it("returns undefined for bv_d_ tokens when daemonRepo is not provided", async () => {
    const out = await lookupApiKey({ agentRepo, personRepo }, "bv_d_anything");
    expect(out).toBeUndefined();
  });
});
