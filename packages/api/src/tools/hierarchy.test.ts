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
  InvalidTaskTransitionError,
  type TaskService,
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
  coreMemoryRepo?: Partial<CoreMemoryBlockRepository>;
  agentProvisionEventRepo?: Partial<AgentProvisionEventRepository>;
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
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
    initDefaults: vi.fn(async () => []),
    ...overrides.coreMemoryRepo,
  } as unknown as CoreMemoryBlockRepository;

  const agentProvisionEventRepo = {
    create: vi.fn(async () => ({})),
    countByParentSince: vi.fn(async () => 0),
    listByParent: vi.fn(async () => []),
    ...overrides.agentProvisionEventRepo,
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
  /** A blocked task assigned to a subordinate of `agent_parent`. */
  function reviseFixture(
    taskOverrides: Partial<Task> = {},
    assigneeOverrides: Partial<Agent> = {},
  ) {
    const task = fakeTask({
      id: "task_blocked",
      status: "blocked",
      assignee_id: "agent_sub",
      ...taskOverrides,
    });
    const assignee = fakeAgent({
      id: "agent_sub",
      hierarchy_level: "ic",
      parent_agent_id: "agent_parent",
      ...assigneeOverrides,
    });
    return { task, assignee };
  }

  function reviseServices(
    opts: {
      task?: Task | undefined;
      assignee?: Agent | undefined;
      revised?: Task;
      reviseThrows?: unknown;
    } = {},
  ) {
    const fx = reviseFixture();
    const task = "task" in opts ? opts.task : fx.task;
    const assignee = "assignee" in opts ? opts.assignee : fx.assignee;
    return buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => assignee) },
      taskService: {
        reviseTask: vi.fn(async () => {
          if (opts.reviseThrows) throw opts.reviseThrows;
          return (
            opts.revised ??
            fakeTask({
              id: "task_blocked",
              status: "needs_revision",
              assignee_id: "agent_sub",
            })
          );
        }),
      },
    });
  }

  function reviseTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools(
      { agentId: "agent_parent", hierarchyLevel: "team" },
      services,
    );
  }

  it("delegates to taskService.reviseTask stamped with the caller as reviser", async () => {
    const services = reviseServices();
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "use the staging credential instead",
    });

    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_blocked",
      "use the staging credential instead",
      { source: "parent_agent", reviserAgentId: "agent_parent" },
    );
    expect(result.isError).toBeFalsy();
    // from_status is read off the pre-revision row, status off the
    // post-revision one — the daemon flips it on claim, not here.
    expect(result.content).toMatchObject({
      revised: true,
      task_id: "task_blocked",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("dispatches the revision session reusing the stamped next_dispatch_context", async () => {
    const reason = {
      kind: "revision" as const,
      feedback: "try the staging credential",
      from_status: "blocked",
      source: "parent_agent",
    };
    const services = reviseServices({
      revised: fakeTask({
        id: "task_blocked",
        status: "needs_revision",
        assignee_id: "agent_sub",
        next_dispatch_context: reason,
      } as Partial<Task>),
    });
    await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "try the staging credential",
    });

    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const call = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]![0];
    expect(call).toMatchObject({
      agentId: "agent_sub",
      type: "task",
      reason,
    });
    // The intent is built from the task + reason, so it carries the feedback.
    expect(String(call.intent)).toContain("try the staging credential");
  });

  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const services = reviseServices();
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "f",
    });

    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["no task_id", { feedback: "f" }],
    ["no feedback", { task_id: "task_blocked" }],
  ])("refuses a call with %s before any lookup", async (_label, input) => {
    const services = reviseServices();
    const result = await callTool(reviseTools(services), "revise_task", input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "task_id and feedback required",
    });
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s on an unknown task", async () => {
    const services = reviseServices({ task: undefined });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_gone",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "task_not_found",
      task_id: "task_gone",
    });
  });

  it("refuses an unassigned task — there's nobody to re-dispatch", async () => {
    const services = reviseServices({
      task: fakeTask({ id: "task_orphan", status: "blocked" }),
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_orphan",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_unassigned" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses when the assignee row is gone", async () => {
    const services = reviseServices({ assignee: undefined });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "assignee_not_found" });
  });

  // Authz is direct-parent only: a grandparent or a peer can't revise.
  it.each([
    ["a grandparent", "agent_grandparent"],
    ["an unrelated agent", undefined],
  ])("refuses a caller who is %s of the assignee", async (_label, parentId) => {
    const services = reviseServices({
      assignee: fakeAgent({
        id: "agent_sub",
        ...(parentId ? { parent_agent_id: parentId } : {}),
      }),
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(String(result.content.message)).toContain("agent_parent");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  // The task-service guards the state machine; the tool only has to name
  // the failure so the agent knows it's the task's state, not its authz.
  it("maps InvalidTaskTransitionError onto invalid_transition", async () => {
    const services = reviseServices({
      reviseThrows: new InvalidTaskTransitionError(
        "cannot revise a task in status done",
      ),
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_transition",
      message: "cannot revise a task in status done",
    });
  });

  it("envelopes any other throw", async () => {
    const services = reviseServices({ reviseThrows: new Error("pool closed") });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_blocked",
      feedback: "f",
    });
    expect(result.content).toEqual({ error: "pool closed" });
  });
});

describe("add_to_escalation", () => {
  function escServices(
    opts: {
      updated?: Record<string, unknown>;
      throws?: unknown;
      poolThrows?: unknown;
    } = {},
  ) {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          if (opts.throws) throw opts.throws;
          return (opts.updated ?? {
            id: "esc_1",
            status: "pending",
          }) as never;
        }),
      },
    });
    if (opts.poolThrows) {
      vi.mocked(services.pool.query).mockRejectedValue(opts.poolThrows);
    }
    return services;
  }

  function escTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools(
      { agentId: "agent_peer", hierarchyLevel: "team" },
      services,
    );
  }

  it("forwards the caller's slot contribution and notifies listeners", async () => {
    const services = escServices();
    const result = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "Phase it", description: "two deploys" }],
      open_questions: ["is there a freeze window?"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_peer",
      proposals: [{ title: "Phase it", description: "two deploys" }],
      openQuestions: ["is there a freeze window?"],
    });
    const notify = vi.mocked(services.pool.query).mock.calls[0]!;
    expect(String(notify[0])).toContain("escalation_updated");
    expect(notify[1]).toEqual(["esc_1"]);
    expect(result.isError).toBeFalsy();
  });

  // both_sides_submitted is what tells the human reviewer the escalation
  // is ready to act on, so it has to track both timestamps, not one.
  it.each([
    ["neither side", {}, false],
    ["only the initiator", { initiator_submitted_at: new Date() }, false],
    ["only the counterparty", { counterparty_submitted_at: new Date() }, false],
    [
      "both sides",
      {
        initiator_submitted_at: new Date(),
        counterparty_submitted_at: new Date(),
      },
      true,
    ],
  ])(
    "reports both_sides_submitted=%s when %s has submitted",
    async (_label, stamps, expected) => {
      const services = escServices({
        updated: { id: "esc_1", status: "pending", ...stamps },
      });
      const result = await callTool(escTools(services), "add_to_escalation", {
        escalation_id: "esc_1",
      });

      expect(result.content).toEqual({
        escalation_id: "esc_1",
        status: "pending",
        both_sides_submitted: expected,
      });
    },
  );

  it.each([
    ["omitted", {}],
    ["a non-array", { proposals: "phase it", open_questions: "when?" }],
  ])("sends %s proposals/questions as undefined", async (_label, extra) => {
    const services = escServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      ...extra,
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("drops non-string open questions but keeps the array", async () => {
    const services = escServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real question", 7, null],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real question"] }),
    );
  });

  it("refuses a missing escalation_id without touching the service", async () => {
    const services = escServices();
    const result = await callTool(escTools(services), "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("envelopes a double-submit refusal from the service", async () => {
    const services = escServices({
      throws: new Error("agent_peer already submitted to esc_1"),
    });
    const result = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "agent_peer already submitted to esc_1",
    });
    expect(services.pool.query).not.toHaveBeenCalled();
  });

  it("envelopes a notify failure", async () => {
    const services = escServices({ poolThrows: new Error("pool closed") });
    const result = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(result.content).toEqual({ error: "pool closed" });
  });
});

describe("create_subordinate_agent", () => {
  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, reads the migration log before guessing",
    domain: "packages/api and packages/core",
  };

  function spawnServices(
    opts: {
      parent?: Agent | undefined;
      recentSpawns?: number;
      auditThrows?: unknown;
      createThrows?: unknown;
    } = {},
  ) {
    const parent =
      "parent" in opts
        ? opts.parent
        : fakeAgent({
            id: "agent_parent",
            name: "Lead",
            owner_id: "person_1",
            hierarchy_level: "team",
            runtime_config: { type: "claude", model: "opus" },
            preferred_runtime_id: "rt_1",
          } as Partial<Agent>);

    return buildServices({
      agentRepo: {
        findById: vi.fn(async () => parent),
        create: vi.fn(async (input: Partial<Agent>) => {
          if (opts.createThrows) throw opts.createThrows;
          return fakeAgent(input);
        }),
      },
      agentProvisionEventRepo: {
        countByParentSince: vi.fn(async () => opts.recentSpawns ?? 0),
        create: vi.fn(async () => {
          if (opts.auditThrows) throw opts.auditThrows;
          return {} as never;
        }),
      },
    });
  }

  function spawnTools(
    services: ReturnType<typeof buildServices>,
    hierarchyLevel: HierarchyLevel = "team",
  ) {
    return buildHierarchyTools({ agentId: "agent_parent", hierarchyLevel }, services);
  }

  it("provisions an IC under the caller, inheriting owner + runtime + daemon", async () => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );

    expect(result.isError).toBeFalsy();
    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0];
    expect(created).toMatchObject({
      name: "Backend specialist",
      owner_id: "person_1",
      parent_agent_id: "agent_parent",
      hierarchy_level: "ic",
      preferred_runtime_id: "rt_1",
    });
    // The parent's runtime wins over the defaults; only the name-bearing
    // system prompt line is overwritten.
    expect(created.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      system_prompt_addition: "You are Backend specialist.",
    });
    expect(result.content).toMatchObject({
      created: {
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_parent",
      },
    });
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = spawnServices({
      parent: fakeAgent({ id: "agent_parent", name: "Lead", owner_id: "person_1" }),
    });
    await callTool(spawnTools(services), "create_subordinate_agent", VALID);

    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0];
    expect("preferred_runtime_id" in created).toBe(false);
  });

  it("seeds the three required identity blocks and nothing else", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", VALID);

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map(([, block]) => block);
    expect(seeded.sort()).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds the optional blocks only when the parent supplied content", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...VALID,
      active_context: "  migrating the task table  ",
      constraints: "never touch prod",
    });

    const calls = vi.mocked(services.coreMemoryRepo.updateContent).mock.calls;
    const byBlock = new Map(calls.map(([, block, content]) => [block, content]));
    expect([...byBlock.keys()].sort()).toEqual([
      "active_context",
      "constraints",
      "domain",
      "persona",
      "tag_line",
    ]);
    // Every field is trimmed before it lands in core memory.
    expect(byBlock.get("active_context")).toBe("migrating the task table");
  });

  it("skips an optional block supplied as whitespace only", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...VALID,
      active_context: "   ",
      constraints: "",
    });

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map(([, block]) => block);
    expect(seeded).not.toContain("active_context");
    expect(seeded).not.toContain("constraints");
  });

  it("writes the provision audit row naming parent, child, persona and domain", async () => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );
    const childId = (result.content as { created: { id: string } }).created.id;

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_parent",
        child_agent_id: childId,
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: VALID.persona,
        domain: VALID.domain,
      }),
    );
  });

  // The agent + its memory are the user-visible artifacts; losing the
  // audit row must not undo a spawn that already happened.
  it("still reports success when the audit row fails to write", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const services = spawnServices({ auditThrows: new Error("audit table gone") });
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );

    expect(result.isError).toBeFalsy();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Tier enforcement is the tool set, not the handler: an IC never gets
  // this tool handed to it. The handler's own `ic_cannot_spawn` branch is
  // defensive depth behind that and is unreachable through the builder,
  // since both the set and the guard read ctx.hierarchyLevel.
  it("is absent from the IC set, so an IC can never call it", () => {
    const icTools = buildHierarchyTools(
      { agentId: "agent_ic", hierarchyLevel: "ic" },
      spawnServices(),
    );
    expect(icTools.map((t) => t.name)).not.toContain("create_subordinate_agent");
  });

  it.each([
    ["name", { ...VALID, name: "  " }],
    ["tag_line", { ...VALID, tag_line: "" }],
    ["persona", { ...VALID, persona: "   " }],
    ["domain", { ...VALID, domain: "" }],
  ])("refuses a blank %s", async (_label, input) => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      input,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("refuses a tag_line over 100 chars and reports the actual length", async () => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      { ...VALID, tag_line: "x".repeat(101) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "tag_line_too_long",
      actual: 101,
    });
  });

  it("accepts a tag_line exactly at the 100-char limit", async () => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      { ...VALID, tag_line: "x".repeat(100) },
    );
    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["over 80 chars", "x".repeat(81)],
    ["a newline", "Backend\nspecialist"],
    ["a NUL byte", "Backend\u0000specialist"],
    ["a DEL byte", "Backend\u007fspecialist"],
  ])("refuses a name containing %s", async (_label, name) => {
    const services = spawnServices();
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      { ...VALID, name },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("refuses when the caller's own agent row is gone", async () => {
    const services = spawnServices({ parent: undefined });
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_parent",
    });
  });

  it("enforces the per-parent 24h spawn cap", async () => {
    const services = spawnServices({ recentSpawns: 8 });
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );

    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_parent",
      86400,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("allows the spawn one under the cap", async () => {
    const services = spawnServices({ recentSpawns: 7 });
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );
    expect(result.isError).toBeFalsy();
  });

  it("envelopes a provisioning failure", async () => {
    const services = spawnServices({ createThrows: new Error("unique violation") });
    const result = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      VALID,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "unique violation" });
    expect(services.coreMemoryRepo.updateContent).not.toHaveBeenCalled();
  });

  it("derives its per-field guidance from the IC core-memory templates", () => {
    const services = spawnServices();
    const schema = findTool(spawnTools(services), "create_subordinate_agent")
      .schema as {
      required: string[];
      properties: Record<string, { description: string }>;
    };

    expect(schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
    // Every block-backed field carries the template's description, so the
    // tool surface and the agent's <core_memory> stay in lockstep.
    for (const field of [
      "tag_line",
      "persona",
      "domain",
      "active_context",
      "constraints",
    ]) {
      expect(schema.properties[field]!.description.length).toBeGreaterThan(0);
    }
  });
});
