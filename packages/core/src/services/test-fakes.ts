/**
 * Full-surface `vi.fn()` repository fakes for core's service unit tests.
 *
 * Every service test needs "a TaskRepository where nothing is stubbed yet",
 * and each one used to spell out the whole method list inline. Six files
 * carried four copies of the `AgentRepository` literal, three of
 * `TaskRepository` and four of `SessionRepository`.
 *
 * Those copies had already rotted, and silently: core's `tsconfig.json`
 * excludes `**\/*.test.ts`, so `tsc` never checks a test file, and a literal
 * annotated `AgentRepository` that is missing a method is accepted. At the
 * time of extraction all four `AgentRepository` copies lacked
 * `findDescendantIds`, one also lacked `findParent`, all three
 * `TaskRepository` copies lacked `findByIds`, and the `SessionRepository`
 * copies named between 8 and 15 of its 18 methods. The fakes here are
 * complete against the current ports, which is strictly safer: an unstubbed
 * call returns `undefined` instead of throwing `TypeError: not a function`.
 *
 * Each factory takes `overrides` for the methods a test actually drives:
 *
 * ```ts
 * taskRepo = makeTaskRepoFake({ update: vi.fn(async (id, patch) => …) });
 * ```
 *
 * These are for the *complete* stubs only. Several tests deliberately build
 * a narrow `{ findById, update } as unknown as TaskRepository` to document
 * the handful of methods the unit under test really touches; that shape is
 * useful and stays local.
 */

import { vi } from "vitest";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { WorkProductRepository } from "../ports/work-product-repo.js";

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
