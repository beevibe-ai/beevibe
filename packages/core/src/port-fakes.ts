import { vi } from "vitest";
import type { AgentRepository } from "./ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "./ports/core-memory-repo.js";
import type { EscalationRepository } from "./ports/escalation-repo.js";
import type {
  NegotiationRepository,
  NegotiationRoundRepository,
} from "./ports/negotiation-repo.js";
import type { DaemonRepository } from "./ports/daemon-repo.js";
import type { PersonRepository } from "./ports/person-repo.js";
import type { SessionRepository } from "./ports/session-repo.js";
import type { TaskRepository } from "./ports/task-repo.js";
import type { WorkProductRepository } from "./ports/work-product-repo.js";

/**
 * Full-surface `vi.fn()` fakes for the repository ports.
 *
 * Fifteen test files across core, api and scheduler each wrote out the same
 * object literals by hand — `AgentRepository` in eight of them,
 * `SessionRepository` in six, `TaskRepository` and `PersonRepository` in
 * three each. Adding one method to a port meant editing every one of them.
 *
 * Worse, nothing was checking: every package's tsconfig excludes its test
 * files, so a literal annotated `AgentRepository` that is missing
 * `findDescendantIds` compiles and runs, and several of the hand-written
 * copies had quietly fallen behind their port that way. This module is NOT
 * excluded from the build, so `tsc` verifies each fake against its port on
 * every `pnpm --filter @beevibe/core build`. A port that grows a method
 * breaks the build here, once, instead of nowhere.
 *
 * Every method is a bare `vi.fn()` — unconfigured, returning `undefined`.
 * Tests stub what they exercise with `vi.mocked(repo.method).mockResolvedValue(…)`
 * and pass `overrides` for a default the whole file wants:
 *
 * ```ts
 * sessionRepo = makeSessionRepoFake({ findLatestForTask: vi.fn(async () => undefined) });
 * ```
 *
 * Lives beside `test-helpers.ts` (the DB-backed fixtures) as a sibling
 * export subpath so api and scheduler can reach it; `vitest` is a devDep of
 * the workspace root, and nothing outside a test imports this.
 */

export function makeAgentRepoFake(overrides: Partial<AgentRepository> = {}): AgentRepository {
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
    ...overrides,
  };
}

export function makePersonRepoFake(overrides: Partial<PersonRepository> = {}): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

export function makeDaemonRepoFake(overrides: Partial<DaemonRepository> = {}): DaemonRepository {
  return {
    findById: vi.fn(),
    findByOwnerAndExternalId: vi.fn(),
    findByTokenHash: vi.fn(),
    listActiveByOwner: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    touchLastSeen: vi.fn(),
    revoke: vi.fn(),
    ...overrides,
  };
}

export function makeSessionRepoFake(
  overrides: Partial<SessionRepository> = {},
): SessionRepository {
  return {
    findById: vi.fn(),
    findLatestForTask: vi.fn(),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    listChatForAgent: vi.fn(),
    softDeleteChatChain: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    listDaemonOrphaned: vi.fn(),
    listPendingForRuntimeIds: vi.fn(),
    claimNextForRuntime: vi.fn(),
    claimNextForServerFallback: vi.fn(),
    cancelPendingForTask: vi.fn(),
    countOwnedByDaemon: vi.fn(),
    findLatestForAgentInRoom: vi.fn(),
    listRunningInRoom: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ...overrides,
  };
}

export function makeTaskRepoFake(overrides: Partial<TaskRepository> = {}): TaskRepository {
  return {
    findById: vi.fn(),
    findByIds: vi.fn(),
    list: vi.fn(),
    listByAssignee: vi.fn(),
    listAssignable: vi.fn(),
    claimById: vi.fn(),
    listReviewQueue: vi.fn(),
    countChildrenNotComplete: vi.fn(),
    countChildren: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateProgress: vi.fn(),
    markBlocked: vi.fn(),
    clearBlocker: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

export function makeWorkProductRepoFake(
  overrides: Partial<WorkProductRepository> = {},
): WorkProductRepository {
  return {
    findById: vi.fn(),
    listByTask: vi.fn(),
    listByAgent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

export function makeEscalationRepoFake(
  overrides: Partial<EscalationRepository> = {},
): EscalationRepository {
  return {
    findById: vi.fn(),
    findByNegotiation: vi.fn(),
    listPending: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ...overrides,
  };
}

export function makeNegotiationRepoFake(
  overrides: Partial<NegotiationRepository> = {},
): NegotiationRepository {
  return {
    findById: vi.fn(),
    findActiveBetween: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ...overrides,
  };
}

export function makeNegotiationRoundRepoFake(
  overrides: Partial<NegotiationRoundRepository> = {},
): NegotiationRoundRepository {
  return {
    listByNegotiation: vi.fn(),
    findLatest: vi.fn(),
    create: vi.fn(),
    ...overrides,
  };
}

/**
 * `CoreMemoryBlockRepository`'s surface is wider than any test needs and its
 * methods take structured inputs, so this one is deliberately a partial fake
 * behind a cast rather than a verified full surface. Kept here so the cast
 * lives in one place instead of per test file.
 */
export function makeCoreMemoryRepoFake(
  overrides: Partial<CoreMemoryBlockRepository> = {},
): CoreMemoryBlockRepository {
  return {
    findByAgentId: vi.fn(),
    findByNames: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    initDefaults: vi.fn(),
    ...overrides,
  } as unknown as CoreMemoryBlockRepository;
}
