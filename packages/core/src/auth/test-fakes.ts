import { vi } from "vitest";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../ports/core-memory-repo.js";
import type { DaemonRepository } from "../ports/daemon-repo.js";
import type { PersonRepository } from "../ports/person-repo.js";

/**
 * Mock-repo factories for the auth unit tests. Each auth unit test file
 * needs the same full-surface `vi.fn()` fakes; colocating them here keeps
 * the mock surface in one place so `AgentRepository` / `PersonRepository`
 * additions only touch one file.
 */

export function makeAgentRepoFake(): AgentRepository {
  return {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findByOwnerId: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findByLevel: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

export function makePersonRepoFake(): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

export function makeDaemonRepoFake(): DaemonRepository {
  return {
    findById: vi.fn(),
    findByOwnerAndExternalId: vi.fn(),
    findByTokenHash: vi.fn(),
    listActiveByOwner: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    touchLastSeen: vi.fn(),
    revoke: vi.fn(),
  };
}

export function makeCoreMemoryRepoFake(): CoreMemoryBlockRepository {
  return {
    findByAgentId: vi.fn(),
    findByNames: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    initDefaults: vi.fn(),
  } as unknown as CoreMemoryBlockRepository;
}
