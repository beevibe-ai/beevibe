/**
 * `assembleTools` integration — full surface vs server_fallback_mesh filter.
 *
 * The fallback filter is the gate for sessions whose target's daemon was
 * offline at dispatch time — they run on the api process with a scratch
 * workspace and must not be allowed to mutate state outside the immediate
 * conversation. This test pins exactly which tool names survive the filter
 * so a future tool addition can't accidentally leak into the restricted
 * surface.
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
 * Sorted tool names for a surface. Every assertion below compares one of
 * these against an exact expected set rather than a `length` plus a
 * handful of `names.has(...)` spot-checks: a magic count breaks on any
 * tool addition while proving nothing about *which* tools are present,
 * and spot-checks only ever covered a subset — neither can tell you a
 * tool leaked into a surface it does not belong in, which is precisely
 * what this file's header promises to pin.
 */
function toolNames(tools: ReturnType<typeof assembleTools>): string[] {
  return tools.map((t) => t.name).sort();
}

describe("assembleTools — daemon (full surface)", () => {
  it("team caller gets the full team surface — task + escalation writes, spawn, capability network, watches, recall", () => {
    const tools = assembleTools(teamCtx(), buildMinimalServices());
    expect(toolNames(tools)).toEqual([
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
    ]);
  });

  it("ic caller gets the IC surface — capability network and recall, but no delegation, spawn or watches", () => {
    const tools = assembleTools(icCtx(), buildMinimalServices());
    // An IC has no subordinates to delegate to or watch for, so
    // create_task, revise_task, create_subordinate_agent, ask/negotiate
    // and watch_tasks/unwatch are all absent — the exact set proves it.
    expect(toolNames(tools)).toEqual([
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
    ]);
  });

  it("owner with capability_network_enabled=false gets neither find_repo nor use_repo", () => {
    const teamTools = assembleTools(teamCtx(undefined, false), buildMinimalServices());
    const teamNames = new Set(teamTools.map((t) => t.name));
    expect(teamNames.has("find_repo")).toBe(false);
    expect(teamNames.has("use_repo")).toBe(false);
    // Other tools survive — flag only gates capability network.
    expect(teamNames.has("create_task")).toBe(true);
    expect(teamNames.has("save_memory")).toBe(true);

    const icTools = assembleTools(icCtx(undefined, false), buildMinimalServices());
    const icNames = new Set(icTools.map((t) => t.name));
    expect(icNames.has("find_repo")).toBe(false);
    expect(icNames.has("use_repo")).toBe(false);
  });
});

describe("assembleTools — server_fallback_mesh (restricted surface)", () => {
  it("leaves a team caller exactly the response, read, escalation and memory tools", () => {
    const tools = assembleTools(
      teamCtx("server_fallback_mesh"),
      buildMinimalServices(),
    );
    // What survives and why: the mesh response paths (respond_ask,
    // respond_negotiate), the escalation openers (report_blocker,
    // escalate_to_humans — they open one rather than write to it), the
    // read surface, update_progress on the in-flight session itself,
    // memory writes as part of the conversation's record, and
    // session_search (read-only and scope-respected). Everything that
    // mutates state outside the conversation — create_task, revise_task,
    // add_to_escalation, create_subordinate_agent, create_work_product,
    // update_work_product, the capability network and the watch tools —
    // is gone. An exact set is what makes that second half enforceable.
    expect(toolNames(tools)).toEqual([
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

  it("ic caller in server_fallback_mesh has no mutating tools either", () => {
    const tools = assembleTools(
      icCtx("server_fallback_mesh"),
      buildMinimalServices(),
    );
    // The team set above minus the tools an IC never had
    // (respond_negotiate, find_subordinates, find_peers, check_work_status)
    // and minus create_work_product/update_work_product, which the filter
    // strips.
    expect(toolNames(tools)).toEqual([
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
