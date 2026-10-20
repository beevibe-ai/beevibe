/**
 * Hierarchy / work-product tools — unit tests with vitest fakes (no DB).
 *
 * Covers the IC-shared and team-only tools plus the IC vs team set gating
 * in `buildHierarchyTools`. Each tool's handler is a thin closure over
 * (ctx, services); the fakes here exercise auth + delegation.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentProvisionEventRepository,
  AgentRepository,
  CoreMemoryBlockRepository,
  Escalation,
  HierarchyLevel,
  Session,
  Task,
  TaskRepository,
  WorkProduct,
  WorkProductListItem,
  WorkProductRepository,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import {
  type TaskService,
  InvalidTaskTransitionError,
} from "@beevibe/core/services/task-service";
import type { EscalationService } from "@beevibe/core/services/escalation-service";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { buildHierarchyTools } from "./hierarchy.js";
import type { AgentTool, AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_a",
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "Build X",
    status: "in_progress",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeWp(overrides: Partial<WorkProduct> = {}): WorkProduct {
  return {
    id: "wp_1",
    task_id: "task_1",
    agent_id: "agent_a",
    type: "pull_request",
    title: "Add error handling",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeWpListItem(
  overrides: Partial<WorkProductListItem> = {},
): WorkProductListItem {
  const { body: _body, ...rest } = fakeWp();
  return { ...rest, body_bytes: 0, ...overrides };
}

function buildServices(overrides: {
  agentRepo?: Partial<AgentRepository>;
  taskRepo?: Partial<TaskRepository>;
  workProductRepo?: Partial<WorkProductRepository>;
  taskService?: Partial<TaskService>;
  memoryAgent?: Partial<MemoryAgent>;
  escalationService?: Partial<EscalationService>;
  dispatchService?: Partial<DispatchService>;
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    findById: vi.fn(async () => undefined),
    listByAssignee: vi.fn(async () => []),
    create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) => fakeTask(input as Partial<Task>)),
    ...overrides.taskRepo,
  } as unknown as TaskRepository;

  const workProductRepo = {
    findById: vi.fn(async () => undefined),
    listByTask: vi.fn(async () => []),
    ...overrides.workProductRepo,
  } as unknown as WorkProductRepository;

  const taskService = {
    updateProgress: vi.fn(async () => fakeTask({ status: "done" })),
    reviseTask: vi.fn(async () => fakeTask({ status: "needs_revision" })),
    createWorkProduct: vi.fn(async (input) => fakeWp(input as Partial<WorkProduct>)),
    listWorkProducts: vi.fn(async () => []),
    getWorkProduct: vi.fn(async () => undefined),
    updateWorkProduct: vi.fn(async (id) => fakeWp({ id })),
    ...overrides.taskService,
  } as unknown as TaskService;

  const memoryAgent = {
    prepareBriefing: vi.fn(async () => ({
      systemPromptAppend: "<core_memory></core_memory>",
      userMessagePrefix: "",
      snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] },
    })),
    onTaskComplete: vi.fn(async () => {}),
    ...overrides.memoryAgent,
  } as unknown as MemoryAgent;

  const escalationService = {
    create: vi.fn(),
    addContribution: vi.fn(async () => ({ id: "esc_1", status: "pending" })),
    resolve: vi.fn(),
    ...overrides.escalationService,
  } as unknown as EscalationService;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: { task?: Task; agentId: string }) => ({
      session: {
        id: "sess_test",
        agent_id: input.agentId,
        type: "task",
        status: "pending",
        intent: "x",
        created_at: new Date(),
      } as Session,
      runtime_id: null,
    })),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
  } as unknown as Pool;

  const coreMemoryRepo = {
    findByAgent: vi.fn(async () => []),
    updateContent: vi.fn(async () => undefined),
    // Called by the real `provisionAgent` inside create_subordinate_agent.
    initDefaults: vi.fn(async () => []),
  } as unknown as CoreMemoryBlockRepository;

  const agentProvisionEventRepo = {
    create: vi.fn(async () => ({})),
    countByParentSince: vi.fn(async () => 0),
    listByParent: vi.fn(async () => []),
  } as unknown as AgentProvisionEventRepository;

  return {
    agentRepo,
    taskRepo,
    workProductRepo,
    taskService,
    memoryAgent,
    escalationService,
    dispatchService,
    pool,
    coreMemoryRepo,
    agentProvisionEventRepo,
  };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} missing from set`);
  return t;
}

async function callTool(
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown> = {},
): Promise<AgentToolResult> {
  return findTool(tools, name).handler(input);
}

// ── Tier gating ──────────────────────────────────────────────────────────

/** Every tier gets these; the IC tier gets nothing else. */
const SHARED_TOOLS = [
  "create_work_product",
  "find_up",
  "get_agent_profile",
  "get_task",
  "get_work_product",
  "list_work_products",
  "search_context",
  "update_progress",
  "update_work_product",
];

/** Delegation surface — only tiers that can have subordinates get these. */
const TEAM_ONLY_TOOLS = [
  "add_to_escalation",
  "check_work_status",
  "create_subordinate_agent",
  "create_task",
  "find_peers",
  "find_subordinates",
  "revise_task",
];

function toolNames(level: HierarchyLevel): string[] {
  return buildHierarchyTools({ agentId: `agent_${level}`, hierarchyLevel: level }, buildServices())
    .map((t) => t.name)
    .sort();
}

describe("buildHierarchyTools — IC vs team gating", () => {
  it("IC tier gets the shared tools and nothing that implies subordinates", () => {
    expect(toolNames("ic")).toEqual([...SHARED_TOOLS].sort());
  });

  it("team tier gets the shared tools plus the delegation surface", () => {
    expect(toolNames("team")).toEqual([...SHARED_TOOLS, ...TEAM_ONLY_TOOLS].sort());
  });

  it("org tier gets exactly the team set (parents have subordinates too)", () => {
    expect(toolNames("org")).toEqual(toolNames("team"));
  });
});

// ── Shared tools ─────────────────────────────────────────────────────────

describe("update_progress", () => {
  it("accepts done/failed/blocked and delegates to taskService.updateProgress", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(
      { agentId: "a", hierarchyLevel: "ic" },
      services,
    );

    const result = await callTool(tools, "update_progress", {
      task_id: "t1",
      status: "done",
      summary: "shipped",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskService.updateProgress).toHaveBeenCalledWith("t1", "done", "shipped");
  });

  it("rejects review (system-only) and other non-end statuses", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "update_progress", {
      task_id: "t1",
      status: "review",
      summary: "x",
    });
    expect(result.isError).toBe(true);
    expect(services.taskService.updateProgress).not.toHaveBeenCalled();
  });
});

describe("find_up", () => {
  it("returns parent projection or null", async () => {
    const parent = fakeAgent({ id: "agent_parent", name: "Boss", hierarchy_level: "team" });
    const services = buildServices({
      agentRepo: { findParent: vi.fn(async () => parent) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "find_up");
    expect((result.content as { parent: { id: string } }).parent.id).toBe("agent_parent");
  });

  it("returns null parent for top-level agents", async () => {
    const services = buildServices({
      agentRepo: { findParent: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "find_up");
    expect((result.content as { parent: unknown }).parent).toBeNull();
  });
});

describe("get_agent_profile + get_task", () => {
  it("get_agent_profile returns null for unknown id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "get_agent_profile", { agent_id: "nope" });
    expect((result.content as { agent: unknown }).agent).toBeNull();
  });

  it("get_task returns null for unknown id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "get_task", { task_id: "nope" });
    expect((result.content as { task: unknown }).task).toBeNull();
  });
});

describe("search_context", () => {
  it("delegates query to memoryAgent.searchArchival and returns the archival envelope", async () => {
    const archival =
      '<archival_memory>\n  <fact type="decision" scope="ic" saved="2026-01-15">Auth uses JWT.</fact>\n</archival_memory>';
    const services = buildServices({
      memoryAgent: {
        searchArchival: vi.fn(async () => archival),
      } as Partial<MemoryAgent>,
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "search_context", { query: "auth flow" });
    expect(services.memoryAgent.searchArchival).toHaveBeenCalledWith("auth flow");
    expect((result.content as { archival: string }).archival).toBe(archival);
  });

  it("rejects empty query", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "search_context", { query: "  " });
    expect(result.isError).toBe(true);
  });
});

// ── Work-product tools ───────────────────────────────────────────────────

describe("create_work_product / list_work_products / update_work_product", () => {
  it("create_work_product validates type and forwards to taskService", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "create_work_product", {
      task_id: "t1",
      type: "pull_request",
      title: "PR: add error handling",
      url: "https://example.com/pr/1",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "t1",
        agent_id: "a",
        type: "pull_request",
        title: "PR: add error handling",
        url: "https://example.com/pr/1",
      }),
    );
  });

  it("create_work_product rejects unknown type", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "create_work_product", {
      task_id: "t1",
      type: "ufo",
      title: "x",
    });
    expect(result.isError).toBe(true);
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("list_work_products returns projected rows", async () => {
    const services = buildServices({
      taskService: {
        listWorkProducts: vi.fn(async () => [
          fakeWpListItem({ id: "wp_1", title: "first" }),
          fakeWpListItem({ id: "wp_2", title: "second", url: "https://example.com/x" }),
        ]),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "list_work_products", { task_id: "t1" });
    const wps = (result.content as { work_products: Array<{ id: string }> }).work_products;
    expect(wps.map((w) => w.id)).toEqual(["wp_1", "wp_2"]);
  });

  it("update_work_product forwards patch to taskService", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "update_work_product", {
      id: "wp_1",
      summary: "v2 summary",
      url: "https://example.com/v2",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskService.updateWorkProduct).toHaveBeenCalledWith("wp_1", {
      summary: "v2 summary",
      body: undefined,
      url: "https://example.com/v2",
      provider: undefined,
      external_id: undefined,
      metadata: undefined,
    });
  });

  it("create_work_product forwards body to taskService", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "create_work_product", {
      task_id: "t1",
      type: "analysis",
      title: "Extracted tables",
      body: "| col | val |\n|-----|-----|\n| a   | 1   |\n",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "analysis",
        title: "Extracted tables",
        body: "| col | val |\n|-----|-----|\n| a   | 1   |\n",
      }),
    );
  });

  it("list_work_products surfaces body_bytes from the repo's SQL-computed size", async () => {
    const services = buildServices({
      taskService: {
        listWorkProducts: vi.fn(async () => [
          fakeWpListItem({ id: "wp_1", body_bytes: 5 }),
          fakeWpListItem({ id: "wp_2", body_bytes: 0 }),
        ]),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "list_work_products", { task_id: "t1" });
    const wps = (
      result.content as { work_products: Array<{ id: string; body_bytes: number }> }
    ).work_products;
    expect(wps).toEqual([
      expect.objectContaining({ id: "wp_1", body_bytes: 5 }),
      expect.objectContaining({ id: "wp_2", body_bytes: 0 }),
    ]);
  });

  it("get_work_product returns full body content", async () => {
    const wp = fakeWp({ id: "wp_1", body: "## Table 1\n\nrow data" });
    const services = buildServices({
      taskService: {
        getWorkProduct: vi.fn(async () => wp),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "get_work_product", { id: "wp_1" });
    expect(result.isError).toBeFalsy();
    const got = (result.content as { work_product: { id: string; body: string } }).work_product;
    expect(got.id).toBe("wp_1");
    expect(got.body).toContain("Table 1");
  });

  it("get_work_product 404s on missing id", async () => {
    const services = buildServices({
      taskService: {
        getWorkProduct: vi.fn(async () => undefined),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);
    const result = await callTool(tools, "get_work_product", { id: "wp_nope" });
    expect(result.isError).toBe(true);
  });
});

// ── Team-only tools ──────────────────────────────────────────────────────

describe("find_subordinates + find_peers", () => {
  it("find_subordinates lists direct children", async () => {
    const subs = [fakeAgent({ id: "s1", hierarchy_level: "ic" }), fakeAgent({ id: "s2", hierarchy_level: "ic" })];
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => subs) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
    const result = await callTool(tools, "find_subordinates");
    expect((result.content as { agents: Array<{ id: string }> }).agents.map((a) => a.id)).toEqual([
      "s1",
      "s2",
    ]);
    expect(services.agentRepo.findSubordinates).toHaveBeenCalledWith("agent_t");
  });

  it("find_peers via agentRepo.findPeers", async () => {
    const peers = [fakeAgent({ id: "p1" })];
    const services = buildServices({
      agentRepo: { findPeers: vi.fn(async () => peers) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
    const result = await callTool(tools, "find_peers");
    expect((result.content as { agents: Array<{ id: string }> }).agents.map((a) => a.id)).toEqual([
      "p1",
    ]);
  });
});

describe("create_task", () => {
  it("authorizes assignee as direct subordinate before creating", async () => {
    const sub = fakeAgent({ id: "sub_1", hierarchy_level: "ic" });
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [sub]) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "Fix the auth bug",
      agent_id: "sub_1",
      priority: "high",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix the auth bug",
        assignee_id: "sub_1",
        creator_id: "agent_t",
        creator_type: "agent",
        status: "assigned",
        priority: "high",
      }),
    );
  });

  it("rejects when assignee is not a direct subordinate", async () => {
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => []) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "x",
      agent_id: "rando",
    });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("not_subordinate");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("check_work_status", () => {
  it("allows checking own work without subordinate lookup", async () => {
    const services = buildServices({
      taskRepo: {
        listByAssignee: vi.fn(async () => [
          fakeTask({ id: "t1", status: "done" }),
          fakeTask({ id: "t2", status: "in_progress" }),
        ]),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "check_work_status", { agent_id: "agent_t" });
    expect(result.isError).toBeFalsy();
    const content = result.content as { counts: Record<string, number> };
    expect(content.counts.done).toBe(1);
    expect(content.counts.in_progress).toBe(1);
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("authorizes against subordinates when checking another agent", async () => {
    const services = buildServices({
      agentRepo: {
        findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]),
      },
      taskRepo: { listByAssignee: vi.fn(async () => []) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "check_work_status", { agent_id: "rando" });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("unauthorized");
  });
});

describe("revise_task", () => {
  /** Blocked task assigned to a direct subordinate — the happy path's shape. */
  function blockedUnderParent() {
    const task = fakeTask({ id: "t_blocked", status: "blocked", assignee_id: "sub_1" });
    const assignee = fakeAgent({
      id: "sub_1",
      hierarchy_level: "ic",
      parent_agent_id: "agent_t",
    });
    return { task, assignee };
  }

  it("requires both task_id and feedback", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    for (const input of [
      { task_id: "", feedback: "go on" },
      { task_id: "t1", feedback: "" },
    ]) {
      const result = await callTool(tools, "revise_task", input);
      expect(result.isError).toBe(true);
    }
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s an unknown task", async () => {
    const services = buildServices({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "nope", feedback: "f" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_not_found", task_id: "nope" });
  });

  it("rejects an unassigned task — there is nobody to revise", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: undefined })) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "t1", feedback: "f" });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("404s when the assignee row is gone", async () => {
    const { task } = blockedUnderParent();
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: task.id, feedback: "f" });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("assignee_not_found");
  });

  it("rejects a caller who is not the assignee's direct parent", async () => {
    const { task, assignee } = blockedUnderParent();
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ ...assignee, parent_agent_id: "someone_else" })),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: task.id, feedback: "f" });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("not_parent");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("revises, dispatches the revision session and reports both statuses", async () => {
    const { task, assignee } = blockedUnderParent();
    const revised = fakeTask({
      id: task.id,
      title: "Build X",
      description: "the details",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "try the other API",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: "agent_t",
      },
    });
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => assignee) },
      taskService: { reviseTask: vi.fn(async () => revised) } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", {
      task_id: task.id,
      feedback: "try the other API",
    });
    expect(result.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(task.id, "try the other API", {
      source: "parent_agent",
      reviserAgentId: "agent_t",
    });
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: revised,
        agentId: "sub_1",
        type: "task",
        reason: revised.next_dispatch_context,
      }),
    );
    // from_status is the pre-revision status; status is what reviseTask
    // left behind (needs_revision until the daemon claims — see #186).
    expect(result.content).toMatchObject({
      revised: true,
      task_id: task.id,
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips dispatch when reviseTask left no revision context", async () => {
    const { task, assignee } = blockedUnderParent();
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => assignee) },
      taskService: {
        reviseTask: vi.fn(async () => fakeTask({ status: "needs_revision", assignee_id: "sub_1" })),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: task.id, feedback: "f" });
    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("maps an InvalidTaskTransitionError to invalid_transition, not a 500", async () => {
    const { task, assignee } = blockedUnderParent();
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => assignee) },
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("Cannot revise task in status 'done'");
        }),
      } as Partial<TaskService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: task.id, feedback: "f" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_transition",
      message: expect.stringContaining("Cannot revise task"),
    });
  });
});

describe("add_to_escalation", () => {
  function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
    return {
      id: "esc_1",
      negotiation_id: "neg_1",
      initiator_session_id: "sess_i",
      counterparty_session_id: "sess_c",
      summary: "who owns the schema",
      initiator_open_questions: [],
      counterparty_open_questions: [],
      escalated_by_role: "initiator",
      status: "pending",
      created_at: new Date("2026-04-01"),
      updated_at: new Date("2026-04-01"),
      ...overrides,
    };
  }

  it("requires escalation_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { proposals: [] });
    expect(result.isError).toBe(true);
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("forwards proposals + open questions and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => fakeEscalation()),
      } as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const proposals = [{ title: "Split it", description: "two tables", tradeoffs: "more joins" }];
    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["who migrates?"],
    });
    expect(result.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals,
      openQuestions: ["who migrates?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(expect.stringContaining("pg_notify"), [
      "esc_1",
    ]);
  });

  it("drops non-string open questions and passes undefined for non-array args", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => fakeEscalation()),
      } as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "not an array",
      open_questions: ["keep", 42, null],
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: ["keep"] }),
    );
  });

  it("reports both_sides_submitted only once each slot has a timestamp", async () => {
    const onlyInitiator = fakeEscalation({ initiator_submitted_at: new Date("2026-04-02") });
    const both = fakeEscalation({
      initiator_submitted_at: new Date("2026-04-02"),
      counterparty_submitted_at: new Date("2026-04-03"),
      status: "pending",
    });

    for (const [esc, expected] of [
      [onlyInitiator, false],
      [both, true],
    ] as const) {
      const services = buildServices({
        escalationService: {
          addContribution: vi.fn(async () => esc),
        } as Partial<EscalationService>,
      });
      const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
      const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
      expect(result.content).toMatchObject({
        escalation_id: "esc_1",
        status: "pending",
        both_sides_submitted: expected,
      });
    }
  });

  it("surfaces a service rejection as a tool error", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("caller already escalated");
        }),
      } as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(result.isError).toBe(true);
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

describe("create_subordinate_agent", () => {
  const PARENT = fakeAgent({
    id: "agent_t",
    name: "Team lead",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude", model: "inherited-model" },
    preferred_runtime_id: "runtime_1",
  });

  /** Valid briefing — every required field present and within limits. */
  const BRIEFING = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic backend engineer",
    domain: "Express routes, Postgres schema",
  };

  /**
   * `provisionAgent` is the real implementation — it only needs
   * agentRepo.create + coreMemoryRepo.initDefaults, so the fakes below
   * exercise it end to end rather than mocking the module.
   */
  function provisioningServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    const services = buildServices({
      ...overrides,
      agentRepo: {
        findById: vi.fn(async (id: string) => (id === PARENT.id ? PARENT : undefined)),
        create: vi.fn(async (input: Parameters<AgentRepository["create"]>[0]) =>
          fakeAgent(input as Partial<Agent>),
        ),
        ...overrides.agentRepo,
      },
    });
    return services;
  }

  function teamTools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: PARENT.id, hierarchyLevel: "team" }, services);
  }

  // The handler's `ic_cannot_spawn` guard is defence in depth only:
  // `buildHierarchyTools` never hands the tool to an IC tier (pinned by
  // the tier-gating block at the top of this file), and the factory
  // isn't exported, so there is no caller that can reach the branch.

  it("requires name, tag_line, persona and domain", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    for (const missing of ["name", "tag_line", "persona", "domain"] as const) {
      const input: Record<string, unknown> = { ...BRIEFING };
      input[missing] = "   ";
      const result = await callTool(tools, "create_subordinate_agent", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("missing_required_fields");
    }
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a tag_line over 100 chars", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...BRIEFING,
      tag_line: "x".repeat(101),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
  });

  it("rejects an over-long name or one carrying control characters", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    for (const name of ["n".repeat(81), "Backend\nspecialist", "Back\u0000end"]) {
      const result = await callTool(tools, "create_subordinate_agent", { ...BRIEFING, name });
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("invalid_name");
    }
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("404s when the calling parent row is missing", async () => {
    const services = provisioningServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "parent_not_found", agent_id: PARENT.id });
  });

  it("enforces the per-parent daily cap", async () => {
    const services = provisioningServices();
    (services.agentProvisionEventRepo.countByParentSince as ReturnType<typeof vi.fn>).mockResolvedValue(
      8,
    );
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      PARENT.id,
      24 * 60 * 60,
    );
  });

  it("provisions an IC that inherits owner, runtime and daemon from the parent", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: BRIEFING.name,
        owner_id: PARENT.owner_id,
        parent_agent_id: PARENT.id,
        hierarchy_level: "ic",
        preferred_runtime_id: "runtime_1",
        runtime_config: {
          type: "claude",
          model: "inherited-model",
          system_prompt_addition: `You are ${BRIEFING.name}.`,
        },
      }),
    );
    const created = (result.content as { created: { hierarchy_level: string; parent_agent_id: string } })
      .created;
    expect(created.hierarchy_level).toBe("ic");
    expect(created.parent_agent_id).toBe(PARENT.id);
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = provisioningServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ ...PARENT, preferred_runtime_id: undefined })),
      },
    });
    const tools = teamTools(services);

    await callTool(tools, "create_subordinate_agent", BRIEFING);
    const input = (services.agentRepo.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("preferred_runtime_id" in input).toBe(false);
  });

  it("seeds the identity blocks and leaves optional ones untouched when blank", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    await callTool(tools, "create_subordinate_agent", BRIEFING);
    const seeded = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(seeded.sort()).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds active_context and constraints when the parent supplies them", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    await callTool(tools, "create_subordinate_agent", {
      ...BRIEFING,
      active_context: "migrating the task table",
      constraints: "no breaking API changes",
    });
    const calls = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[1]).sort()).toEqual([
      "active_context",
      "constraints",
      "domain",
      "persona",
      "tag_line",
    ]);
    expect(calls.find((c) => c[1] === "constraints")?.[2]).toBe("no breaking API changes");
  });

  it("writes the provision audit row linking parent to child", async () => {
    const services = provisioningServices();
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    const childId = (result.content as { created: { id: string } }).created.id;
    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: PARENT.id,
        child_agent_id: childId,
        owner_person_id: PARENT.owner_id,
        child_name: BRIEFING.name,
        persona: BRIEFING.persona,
        domain: BRIEFING.domain,
      }),
    );
  });

  it("still reports the spawn when the audit row fails to write", async () => {
    const services = provisioningServices();
    (services.agentProvisionEventRepo.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("audit table gone"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    expect(result.isError).toBeFalsy();
    expect((result.content as { created: { name: string } }).created.name).toBe(BRIEFING.name);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("surfaces a provisioning failure as a tool error", async () => {
    const services = provisioningServices({
      agentRepo: {
        findById: vi.fn(async () => PARENT),
        create: vi.fn(async () => {
          throw new Error("insert failed");
        }),
      },
    });
    const tools = teamTools(services);

    const result = await callTool(tools, "create_subordinate_agent", BRIEFING);
    expect(result.isError).toBe(true);
    expect(services.agentProvisionEventRepo.create).not.toHaveBeenCalled();
  });
});
