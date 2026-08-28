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
 * Every assertion here compares the whole sorted name set rather than
 * spot-checking membership or counting — a count passes for the wrong set,
 * and a `names.has(...)` sweep says nothing about a tool nobody thought to
 * list. Adding a tool is meant to fail these; the fix is to add it to the
 * table above the tier it belongs to, which is the review moment.
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

/** Everything an IC gets on a daemon, capability network on. */
const IC_TOOLS = [
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

/** Added on top of the IC set for tiers that can have subordinates. */
const TEAM_ONLY_TOOLS = [
  "add_to_escalation",
  "ask",
  "check_work_status",
  "create_subordinate_agent",
  "create_task",
  "escalate_to_humans",
  "find_peers",
  "find_subordinates",
  "negotiate",
  "respond_negotiate",
  "revise_task",
  "unwatch",
  "watch_tasks",
];

/** Gated off by owner flag `capability_network_enabled = false`. */
const CAPABILITY_NETWORK_TOOLS = ["find_repo", "use_repo"];

/**
 * Exactly what a team caller keeps under `server_fallback_mesh`: mesh
 * response paths, escalation openers, read-only context, progress on the
 * in-flight session, and the memory writes that are part of the
 * conversation's own record. Nothing that mutates state outside it, and
 * no capability-network tools.
 */
const TEAM_FALLBACK_TOOLS = [
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
];

/** The team fallback set minus everything that implies subordinates. */
const IC_FALLBACK_TOOLS = TEAM_FALLBACK_TOOLS.filter(
  (n) =>
    ![
      "check_work_status",
      "escalate_to_humans",
      "find_peers",
      "find_subordinates",
      "respond_negotiate",
    ].includes(n),
);

function toolNames(ctx: AssembleToolsContext): string[] {
  return assembleTools(ctx, buildMinimalServices())
    .map((t) => t.name)
    .sort();
}

describe("assembleTools — daemon (full surface)", () => {
  it("ic caller gets exactly the IC surface", () => {
    expect(toolNames(icCtx())).toEqual([...IC_TOOLS].sort());
  });

  it("team caller gets exactly the IC surface plus the delegation surface", () => {
    expect(toolNames(teamCtx())).toEqual([...IC_TOOLS, ...TEAM_ONLY_TOOLS].sort());
  });

  it("capability_network_enabled=false drops find_repo + use_repo and nothing else", () => {
    expect(toolNames(teamCtx(undefined, false))).toEqual(
      [...IC_TOOLS, ...TEAM_ONLY_TOOLS]
        .filter((n) => !CAPABILITY_NETWORK_TOOLS.includes(n))
        .sort(),
    );
    expect(toolNames(icCtx(undefined, false))).toEqual(
      IC_TOOLS.filter((n) => !CAPABILITY_NETWORK_TOOLS.includes(n)).sort(),
    );
  });
});

describe("assembleTools — server_fallback_mesh (restricted surface)", () => {
  it("a team caller keeps exactly the read/respond/memory surface", () => {
    expect(toolNames(teamCtx("server_fallback_mesh"))).toEqual(
      [...TEAM_FALLBACK_TOOLS].sort(),
    );
  });

  it("an ic caller keeps exactly that set minus the subordinate-implying tools", () => {
    expect(toolNames(icCtx("server_fallback_mesh"))).toEqual(
      [...IC_FALLBACK_TOOLS].sort(),
    );
  });

  it("every mutating tool is stripped for both tiers", () => {
    // The invariant the filter exists for: nothing that writes state
    // outside the in-flight conversation survives.
    const mutating = [
      "add_to_escalation",
      "ask",
      "create_subordinate_agent",
      "create_task",
      "create_work_product",
      "negotiate",
      "revise_task",
      "unwatch",
      "update_work_product",
      "watch_tasks",
    ];
    for (const name of mutating) {
      expect(TEAM_FALLBACK_TOOLS).not.toContain(name);
      expect(toolNames(teamCtx("server_fallback_mesh"))).not.toContain(name);
      expect(toolNames(icCtx("server_fallback_mesh"))).not.toContain(name);
    }
  });
});
