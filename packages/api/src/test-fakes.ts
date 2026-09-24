/**
 * Full-surface `vi.fn()` repository fakes for the api's no-DB unit tests.
 *
 * These are the stubs that name *every* method on a port. `routes/me.test.ts`,
 * `routes/signin.test.ts` and `routes/signup.test.ts` each carried their own
 * byte-identical copy, so adding a method to `PersonRepository` or
 * `AgentRepository` broke three files at once and had to be fixed three
 * times — mechanical work that the type checker was right to demand but that
 * nothing deduplicated.
 *
 * Deliberately NOT for the partial stubs. `routes/room.test.ts` and
 * `routes/repo-runs.test.ts` build narrow `as unknown as Repo` objects with
 * only the handful of methods the route under test actually calls; that is a
 * different (and useful) shape — it documents the route's real dependency
 * surface — and those stay local.
 *
 * Mirrors `packages/core/src/auth/test-fakes.ts`, which does the same job for
 * core's auth unit tests. The two can't share one module today: core's
 * tsconfig excludes `**\/test-fakes.ts` from the build on purpose, so the file
 * never reaches `dist/` and there is no package export for api to import.
 */

import { vi } from "vitest";
import type {
  AgentRepository,
  CoreMemoryBlockRepository,
  PersonRepository,
} from "@beevibe/core";

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

export function makeAgentRepoFake(): AgentRepository {
  return {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    findByLevel: vi.fn(),
    findDescendantIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

/**
 * `initDefaults` resolves to `[]` rather than `undefined`: callers that
 * provision an agent await it, and a bare `vi.fn()` would hand them
 * `undefined` to iterate.
 */
export function makeCoreMemoryRepoFake(): CoreMemoryBlockRepository {
  return {
    findByAgentId: vi.fn(),
    findByNames: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    initDefaults: vi.fn().mockResolvedValue([]),
  } as unknown as CoreMemoryBlockRepository;
}
