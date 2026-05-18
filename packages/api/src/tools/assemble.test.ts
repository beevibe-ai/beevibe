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
  };
}

function teamCtx(spawnMode?: AssembleToolsContext["spawnMode"]): AssembleToolsContext {
  const caller: McpCaller = {
    source: "agent",
    agentId: "agent_team",
    hierarchyLevel: "team",
  };
  return { caller, beevibeSid: "sess_test", spawnMode };
}

function icCtx(spawnMode?: AssembleToolsContext["spawnMode"]): AssembleToolsContext {
  const caller: McpCaller = {
    source: "agent",
    agentId: "agent_ic",
    hierarchyLevel: "ic",
  };
  return { caller, beevibeSid: "sess_test", spawnMode };
}

describe("assembleTools — daemon (full surface)", () => {
  it("team caller gets the full team surface (24 tools)", () => {
    const tools = assembleTools(teamCtx(), buildMinimalServices());
    expect(tools.length).toBe(24);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("create_task")).toBe(true);
    expect(names.has("update_work_product")).toBe(true);
    expect(names.has("get_work_product")).toBe(true);
    expect(names.has("revise_task")).toBe(true);
    expect(names.has("add_to_escalation")).toBe(true);
    expect(names.has("create_subordinate_agent")).toBe(true);
  });

  it("ic caller gets the IC surface (13 tools)", () => {
    const tools = assembleTools(icCtx(), buildMinimalServices());
    expect(tools.length).toBe(13);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("create_task")).toBe(false);
    expect(names.has("respond_ask")).toBe(true);
    expect(names.has("report_blocker")).toBe(true);
  });
});

describe("assembleTools — server_fallback_mesh (restricted surface)", () => {
  it("strips mutating tools from a team caller", () => {
    const tools = assembleTools(
      teamCtx("server_fallback_mesh"),
      buildMinimalServices(),
    );
    const names = new Set(tools.map((t) => t.name));
    // Mutating tools — must NOT be present
    expect(names.has("create_task")).toBe(false);
    expect(names.has("update_work_product")).toBe(false);
    expect(names.has("revise_task")).toBe(false);
    expect(names.has("add_to_escalation")).toBe(false);
    expect(names.has("create_subordinate_agent")).toBe(false);
    expect(names.has("create_work_product")).toBe(false);
  });

  it("keeps response, read, escalation, and memory tools for a team caller", () => {
    const tools = assembleTools(
      teamCtx("server_fallback_mesh"),
      buildMinimalServices(),
    );
    const names = new Set(tools.map((t) => t.name));
    // Mesh response paths
    expect(names.has("respond_ask")).toBe(true);
    expect(names.has("respond_negotiate")).toBe(true);
    // Escalation paths (they don't write to escalation, they just open one)
    expect(names.has("report_blocker")).toBe(true);
    expect(names.has("escalate_to_humans")).toBe(true);
    // Read context
    expect(names.has("search_context")).toBe(true);
    expect(names.has("get_agent_profile")).toBe(true);
    expect(names.has("get_task")).toBe(true);
    expect(names.has("find_up")).toBe(true);
    expect(names.has("find_subordinates")).toBe(true);
    expect(names.has("find_peers")).toBe(true);
    expect(names.has("list_work_products")).toBe(true);
    expect(names.has("check_work_status")).toBe(true);
    // Update progress on the in-flight session itself
    expect(names.has("update_progress")).toBe(true);
    // Memory writes are part of the conversation's record
    expect(names.has("save_memory")).toBe(true);
    expect(names.has("update_core_memory")).toBe(true);
  });

  it("ic caller in server_fallback_mesh has no mutating tools either", () => {
    const tools = assembleTools(
      icCtx("server_fallback_mesh"),
      buildMinimalServices(),
    );
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("create_task")).toBe(false);
    expect(names.has("update_work_product")).toBe(false);
    expect(names.has("respond_ask")).toBe(true);
  });
});
