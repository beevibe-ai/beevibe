/**
 * `assembleTools` integration — full surface vs server_fallback_mesh filter.
 *
 * The fallback filter is the gate for sessions whose target's daemon was
 * offline at dispatch time — they run on the api process with a scratch
 * workspace and must not be allowed to mutate state outside the immediate
 * conversation. This test pins exactly which tool names survive the filter
 * so a future tool addition can't accidentally leak into the restricted
 * surface.
 *
 * Every case asserts the whole sorted name set rather than a count plus a
 * handful of `names.has(...)` spot-checks. A count can't say *which* tool
 * appeared or vanished, and spot-checks only catch the names someone
 * thought to list — the restricted team surface was missing
 * `get_work_product` from its list, so a regression that dropped it would
 * have gone unnoticed. Adding a tool now fails with the name in the diff,
 * which is the review prompt: should the fallback surface get it too?
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentProvisionEventRepository,
  AgentRepository,
  CoreMemoryBlockRepository,
  LearnedSkillRepository,
  TaskRepository,
  WorkProductRepository,
} from "@beevibe/core";
import type { Pool } from "@beevibe/core/adapters/postgres";
import type {
  CoreMemory,
  FactStore,
  MemoryAgent,
} from "@beevibe/core/services/memory";
import type { TaskService } from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { WatchService } from "@beevibe/core/services/watch-service";
import type { SessionSearchService } from "@beevibe/core/services/session-search";
import type { MeshServer } from "../mesh/server.js";
import {
  assembleTools,
  type AssembleToolsContext,
  type AssembleToolsServices,
  type McpCaller,
} from "./assemble.js";

function buildMinimalServices(): AssembleToolsServices {
  const noop = vi.fn();
  return {
    factStore: { addOrMerge: noop } as unknown as FactStore,
    coreMemory: { upsert: noop } as unknown as CoreMemory,
    coreMemoryRepo: {
      findByAgent: vi.fn(async () => []),
    } as unknown as CoreMemoryBlockRepository,
    agentProvisionEventRepo: {
      create: vi.fn(),
      countByParentSince: vi.fn(async () => 0),
      listByParent: vi.fn(async () => []),
    } as unknown as AgentProvisionEventRepository,
    agentRepo: {
      findById: vi.fn(async () => undefined),
    } as unknown as AgentRepository,
    taskRepo: {} as unknown as TaskRepository,
    workProductRepo: {} as unknown as WorkProductRepository,
    taskService: {} as unknown as TaskService,
    escalationService: {} as unknown as EscalationService,
    dispatchService: {} as unknown as DispatchService,
    mesh: {} as unknown as MeshServer,
    pool: {} as unknown as Pool,
    memoryAgent: {} as unknown as MemoryAgent,
    repoRunRepo: {} as unknown as import("@beevibe/core").RepoRunRepository,
    learnedSkillRepo: {
      searchByGoal: vi.fn(async () => []),
    } as unknown as LearnedSkillRepository,
    embeddings: {
      type: "fake",
      embed: vi.fn(async () => [1, 0]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
    },
    watchService: {} as unknown as WatchService,
    sessionSearch: {
      search: vi.fn(async () => ({ kind: "browse", sessions: [] })),
    } as unknown as SessionSearchService,
  };
}

function teamCtx(
  spawnMode?: AssembleToolsContext["spawnMode"],
  capabilityNetworkEnabled = true,
): AssembleToolsContext {
  const caller: McpCaller = {
    source: "agent",
    agentId: "agent_team",
    hierarchyLevel: "team",
  };
  return { caller, beevibeSid: "sess_test", spawnMode, capabilityNetworkEnabled };
}

function icCtx(
  spawnMode?: AssembleToolsContext["spawnMode"],
  capabilityNetworkEnabled = true,
): AssembleToolsContext {
  const caller: McpCaller = {
    source: "agent",
    agentId: "agent_ic",
    hierarchyLevel: "ic",
  };
  return { caller, beevibeSid: "sess_test", spawnMode, capabilityNetworkEnabled };
}

/**
 * The daemon surface, in full. `capability_network_enabled` gates exactly
 * the two capability-network tools, so the flag-off expectations are
 * derived rather than retyped.
 */
const CAPABILITY_NETWORK_TOOLS = ["find_repo", "use_repo"] as const;

const TEAM_DAEMON_TOOLS = [
  "add_to_escalation",
  "ask",
  "check_work_status",
  "create_subordinate_agent",
  "create_task",
  "create_work_product",
  "escalate_to_humans",
  "find_peers",
  "find_repo",
  "find_subordinates",
  "find_up",
  "get_agent_profile",
  "get_task",
  "get_work_product",
  "list_work_products",
  "negotiate",
  "report_blocker",
  "respond_ask",
  "respond_negotiate",
  "revise_task",
  "save_memory",
  "search_context",
  "session_search",
  "unwatch",
  "update_core_memory",
  "update_progress",
  "update_work_product",
  "use_repo",
  "watch_tasks",
];

const IC_DAEMON_TOOLS = [
  "create_work_product",
  "find_repo",
  "find_up",
  "get_agent_profile",
  "get_task",
  "get_work_product",
  "list_work_products",
  "report_blocker",
  "respond_ask",
  "save_memory",
  "search_context",
  "session_search",
  "update_core_memory",
  "update_progress",
  "update_work_product",
  "use_repo",
];

function without(names: string[], drop: readonly string[]): string[] {
  return names.filter((n) => !drop.includes(n));
}

function namesOf(ctx: AssembleToolsContext): string[] {
  return assembleTools(ctx, buildMinimalServices())
    .map((t) => t.name)
    .sort();
}

describe("assembleTools — daemon (full surface)", () => {
  it("team caller gets the full team surface", () => {
    expect(namesOf(teamCtx())).toEqual(TEAM_DAEMON_TOOLS);
  });

  // The IC set is the team set minus everything that implies subordinates
  // (create_task, find_subordinates, check_work_status, …) and minus the
  // initiator-side mesh surface (ask, negotiate) — plus no watch_tasks /
  // unwatch, which only a delegating tier has anything to watch.
  it("ic caller gets the IC surface", () => {
    expect(namesOf(icCtx())).toEqual(IC_DAEMON_TOOLS);
  });

  it("capability_network_enabled=false gates find_repo + use_repo and nothing else", () => {
    expect(namesOf(teamCtx(undefined, false))).toEqual(
      without(TEAM_DAEMON_TOOLS, CAPABILITY_NETWORK_TOOLS),
    );
    expect(namesOf(icCtx(undefined, false))).toEqual(
      without(IC_DAEMON_TOOLS, CAPABILITY_NETWORK_TOOLS),
    );
  });
});

describe("assembleTools — server_fallback_mesh (restricted surface)", () => {
  // What survives the filter, and why: the mesh response paths
  // (respond_ask / respond_negotiate), the two escalation openers (which
  // don't write to an existing escalation), the read-only context and
  // work-product queries, update_progress on the in-flight session itself,
  // the two memory writes that are part of the conversation's own record,
  // and session_search, whose layer-3 recall is read-only and
  // scope-respected. Everything that mutates state outside the
  // conversation is gone: create_task, create_work_product,
  // update_work_product, revise_task, add_to_escalation,
  // create_subordinate_agent, the initiator-side ask/negotiate, and the
  // capability-network and watch tools.
  it("strips every tool that mutates state outside the conversation — team caller", () => {
    expect(namesOf(teamCtx("server_fallback_mesh"))).toEqual([
      "check_work_status",
      "escalate_to_humans",
      "find_peers",
      "find_subordinates",
      "find_up",
      "get_agent_profile",
      "get_task",
      "get_work_product",
      "list_work_products",
      "report_blocker",
      "respond_ask",
      "respond_negotiate",
      "save_memory",
      "search_context",
      "session_search",
      "update_core_memory",
      "update_progress",
    ]);
  });

  it("applies the same filter to an ic caller, on top of the IC tier gating", () => {
    expect(namesOf(icCtx("server_fallback_mesh"))).toEqual([
      "find_up",
      "get_agent_profile",
      "get_task",
      "get_work_product",
      "list_work_products",
      "report_blocker",
      "respond_ask",
      "save_memory",
      "search_context",
      "session_search",
      "update_core_memory",
      "update_progress",
    ]);
  });
});
