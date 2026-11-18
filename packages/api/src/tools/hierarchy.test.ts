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
import { DEFAULT_BLOCK_TEMPLATES } from "@beevibe/core";
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
    // provisionAgent (create_subordinate_agent) inserts through this.
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
    // provisionAgent seeds the tier's default blocks through this.
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
  /** A blocked task assigned to `sub_1`, whose parent is `agent_t`. */
  function reviseFixture(
    overrides: {
      task?: Partial<Task>;
      assignee?: Partial<Agent> | undefined;
      revised?: Partial<Task>;
    } = {},
  ) {
    const task = fakeTask({
      id: "task_b",
      status: "blocked",
      assignee_id: "sub_1",
      ...overrides.task,
    });
    const assignee =
      overrides.assignee === undefined && "assignee" in overrides
        ? undefined
        : fakeAgent({
            id: "sub_1",
            hierarchy_level: "ic",
            parent_agent_id: "agent_t",
            ...overrides.assignee,
          });
    const revised = fakeTask({
      id: "task_b",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the staging key",
        from_status: "blocked",
      },
      ...overrides.revised,
    } as Partial<Task>);

    return buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: { findById: vi.fn(async () => assignee) },
      taskService: { reviseTask: vi.fn(async () => revised) },
    });
  }

  const OK_INPUT = { task_id: "task_b", feedback: "use the staging key" };

  it("transitions the task and dispatches the revision session", async () => {
    const services = reviseFixture();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({
      revised: true,
      task_id: "task_b",
      // Post-#186 the task stays at needs_revision until the daemon
      // claims the session — it must NOT optimistically read "revision".
      status: "needs_revision",
      from_status: "blocked",
    });
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_b",
      "use the staging key",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
  });

  it("dispatches to the assignee reusing the stamped revision context", async () => {
    const services = reviseFixture();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    await callTool(tools, "revise_task", OK_INPUT);

    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sub_1",
        type: "task",
        reason: {
          kind: "revision",
          feedback: "use the staging key",
          from_status: "blocked",
        },
      }),
    );
    // The feedback has to reach the agent's prompt, not just the DB row.
    const dispatched = vi.mocked(services.dispatchService.dispatchTask).mock
      .calls[0]?.[0];
    expect(dispatched?.intent).toContain("use the staging key");
  });

  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const services = reviseFixture({
      revised: { next_dispatch_context: undefined } as Partial<Task>,
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["both missing", {}],
    ["no feedback", { task_id: "task_b" }],
    ["no task id", { feedback: "f" }],
    ["blank feedback", { task_id: "task_b", feedback: "" }],
  ])("rejects %s before any lookup", async (_label, input) => {
    const services = reviseFixture();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_id and feedback required");
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s on an unknown task", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "task_not_found",
      task_id: "task_b",
    });
  });

  it("rejects an unassigned task — there's nobody to re-dispatch", async () => {
    const services = reviseFixture({
      task: { assignee_id: undefined } as Partial<Task>,
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("task_unassigned");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("rejects when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("assignee_not_found");
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    // Grandparent / sibling / unrelated all land here: authz is strictly
    // `assignee.parent_agent_id === caller`, not reachability.
    const services = reviseFixture({ assignee: { parent_agent_id: "someone_else" } });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("not_parent");
    expect(String(res.content.message)).toContain("agent_t");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps InvalidTaskTransitionError to invalid_transition", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "done", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_t" }),
        ),
      },
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "task task_b is done; revise_task accepts blocked only",
          );
        }),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_transition");
    expect(res.content.message).toBeTruthy();
  });

  it("envelopes an unexpected throw", async () => {
    const services = reviseFixture();
    vi.mocked(services.taskService.reviseTask).mockRejectedValueOnce(
      new Error("pg down"),
    );
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    const res = await callTool(tools, "revise_task", OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "pg down" });
  });
});

describe("add_to_escalation", () => {
  /**
   * `addContribution` returns only the fields the tool projects, so the
   * fake supplies that subset rather than a whole Escalation row.
   */
  function escServices(
    addContribution: () => Promise<unknown> = async () => ({
      id: "esc_1",
      status: "pending",
      initiator_submitted_at: new Date("2026-04-01"),
      counterparty_submitted_at: undefined,
    }),
  ) {
    return buildServices({
      escalationService: {
        addContribution: vi.fn(addContribution),
      } as unknown as Partial<EscalationService>,
    });
  }

  function escTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
  }

  it("records the caller's contribution and notifies listeners", async () => {
    const services = escServices();
    const res = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "B", description: "do B" }],
      open_questions: ["what's the deadline?"],
    });

    expect(res.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      // Slot is derived from the caller's role on the negotiation.
      callerAgentId: "agent_t",
      proposals: [{ title: "B", description: "do B" }],
      openQuestions: ["what's the deadline?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
  });

  it("reports both_sides_submitted=false while one slot is still empty", async () => {
    const res = await callTool(escTools(escServices()), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });
  });

  it("reports both_sides_submitted=true once both slots are filled", async () => {
    const services = escServices(async () => ({
      id: "esc_1",
      status: "ready_for_human",
      initiator_submitted_at: new Date("2026-04-01"),
      counterparty_submitted_at: new Date("2026-04-02"),
    }));
    const res = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(res.content).toEqual({
      escalation_id: "esc_1",
      status: "ready_for_human",
      both_sides_submitted: true,
    });
  });

  it.each([
    ["absent", {}],
    ["blank", { escalation_id: "" }],
  ])("rejects an escalation_id that is %s", async (_label, input) => {
    const services = escServices();
    const res = await callTool(escTools(services), "add_to_escalation", input);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("escalation_id required");
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("takes no summary arg — the initiator's is immutable", () => {
    const tool = findTool(escTools(escServices()), "add_to_escalation");
    const props = tool.schema.properties as Record<string, unknown>;
    expect(props.summary).toBeUndefined();
    expect(tool.schema.required).toEqual(["escalation_id"]);
  });

  it.each([
    ["absent", undefined],
    ["not an array", { title: "B" }],
  ])("sends no proposals when they are %s", async (_label, proposals) => {
    const services = escServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined }),
    );
  });

  it("filters non-string open_questions", async () => {
    const services = escServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real?", 1, null, "also?"],
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real?", "also?"] }),
    );
  });

  it("envelopes a double-submit rejection and skips the notify", async () => {
    const services = escServices(async () => {
      throw new Error("already submitted");
    });
    const res = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "already submitted" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

describe("create_subordinate_agent", () => {
  const OK_INPUT = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, test-first",
    domain: "packages/api",
  };

  /** Services whose parent lookup resolves to a team agent. */
  function spawnServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ) {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_t",
            name: "Team lead",
            owner_id: "person_1",
            runtime_config: { type: "claude", model: "opus" },
          }),
        ),
        create: vi.fn(async (input: Partial<Agent>) =>
          fakeAgent({ ...input, id: "agent_new" }),
        ),
        ...overrides.agentRepo,
      },
      ...overrides,
    });
  }

  function spawnTools(
    services: ReturnType<typeof buildServices>,
    hierarchyLevel: HierarchyLevel = "team",
  ) {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel }, services);
  }

  it("creates the IC under the caller and returns its id", async () => {
    const services = spawnServices();
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );

    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual({
      created: {
        id: "agent_new",
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_t",
      },
    });
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Backend specialist",
        // Same human owns the child; spawning never crosses owners.
        owner_id: "person_1",
        parent_agent_id: "agent_t",
        // Subordinates are always ICs — spawning can't mint a peer.
        hierarchy_level: "ic",
      }),
    );
  });

  it("inherits the parent's runtime config but rewrites the prompt addition", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", OK_INPUT);
    const runtimeConfig = vi.mocked(services.agentRepo.create).mock.calls[0]?.[0]
      .runtime_config as Record<string, unknown> | undefined;
    // Shared Claude auth + model, so the whole team runs the same way...
    expect(runtimeConfig).toMatchObject({ type: "claude", model: "opus" });
    // ...but the identity line is the child's own. The persona lives in
    // core memory and must not be duplicated into the system prompt.
    expect(runtimeConfig?.system_prompt_addition).toBe(
      "You are Backend specialist.",
    );
    expect(String(runtimeConfig?.system_prompt_addition)).not.toContain(
      "Pragmatic",
    );
  });

  it("pins the child to the parent's runtime when the parent has one", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", preferred_runtime_id: "rt_1" }),
        ),
        create: vi.fn(async (input: Partial<Agent>) =>
          fakeAgent({ ...input, id: "agent_new" }),
        ),
      },
    });
    await callTool(spawnTools(services), "create_subordinate_agent", OK_INPUT);
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_runtime_id: "rt_1" }),
    );
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", OK_INPUT);
    const created = vi.mocked(services.agentRepo.create).mock.calls[0]?.[0];
    expect(created && "preferred_runtime_id" in created).toBe(false);
  });

  it("seeds the three required identity blocks", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", OK_INPUT);
    for (const [block, content] of [
      ["tag_line", "Owns the API surface"],
      ["persona", "Pragmatic, test-first"],
      ["domain", "packages/api"],
    ]) {
      expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
        "agent_new",
        block,
        content,
      );
    }
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledTimes(3);
  });

  it("seeds the optional blocks only when the parent supplied content", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...OK_INPUT,
      active_context: "Migrating auth to JWT",
      constraints: "No schema changes this sprint",
    });
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
      "agent_new",
      "active_context",
      "Migrating auth to JWT",
    );
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
      "agent_new",
      "constraints",
      "No schema changes this sprint",
    );
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledTimes(5);
  });

  it("leaves blank optional blocks empty for the IC to fill in", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...OK_INPUT,
      active_context: "   ",
      constraints: "",
    });
    const blocks = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => c[1]);
    expect(blocks).not.toContain("active_context");
    expect(blocks).not.toContain("constraints");
  });

  it("writes the provision audit row", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", OK_INPUT);
    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        child_agent_id: "agent_new",
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: "Pragmatic, test-first",
        domain: "packages/api",
      }),
    );
  });

  it("still reports success when the audit row fails to write", async () => {
    // The agent + its memory are the user-visible artifacts; losing the
    // audit row must not look like a failed spawn to the caller.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = spawnServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table missing");
        }),
      },
    });
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatchObject({ created: { id: "agent_new" } });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("is not handed to an IC caller at all", () => {
    // The handler also carries an `ic_cannot_spawn` guard, but it is
    // unreachable through buildHierarchyTools — the tier gate drops the
    // tool first. Tier gating is the behavior that holds; the guard is
    // defence-in-depth for any future caller that builds the tool
    // directly.
    const names = spawnTools(spawnServices(), "ic").map((t) => t.name);
    expect(names).not.toContain("create_subordinate_agent");
  });

  it("is reachable by an org caller", async () => {
    const services = spawnServices();
    const res = await callTool(
      spawnTools(services, "org"),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBeFalsy();
  });

  it.each([
    ["name", { ...OK_INPUT, name: "" }],
    ["tag_line", { ...OK_INPUT, tag_line: "  " }],
    ["persona", { ...OK_INPUT, persona: "" }],
    ["domain", { ...OK_INPUT, domain: "" }],
  ])("rejects a blank %s", async (_field, input) => {
    const services = spawnServices();
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      input,
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("missing_required_fields");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("trims the supplied fields", async () => {
    const services = spawnServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      name: "  Backend specialist  ",
      tag_line: "  t  ",
      persona: "  p  ",
      domain: "  d  ",
    });
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Backend specialist" }),
    );
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
      "agent_new",
      "tag_line",
      "t",
    );
  });

  it("accepts a 100-char tag_line but rejects 101", async () => {
    const services = spawnServices();
    const ok = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      { ...OK_INPUT, tag_line: "x".repeat(100) },
    );
    expect(ok.isError).toBeFalsy();

    const tooLong = await callTool(
      spawnTools(spawnServices()),
      "create_subordinate_agent",
      { ...OK_INPUT, tag_line: "x".repeat(101) },
    );
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toMatchObject({
      error: "tag_line_too_long",
      actual: 101,
    });
  });

  it("accepts an 80-char name but rejects 81", async () => {
    const ok = await callTool(
      spawnTools(spawnServices()),
      "create_subordinate_agent",
      { ...OK_INPUT, name: "x".repeat(80) },
    );
    expect(ok.isError).toBeFalsy();

    const tooLong = await callTool(
      spawnTools(spawnServices()),
      "create_subordinate_agent",
      { ...OK_INPUT, name: "x".repeat(81) },
    );
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content.error).toBe("invalid_name");
  });

  it.each([
    ["a NUL byte", "Back\u0000end"],
    ["a newline", "Back\nend"],
    ["a DEL byte", "Back\u007fend"],
  ])("rejects a name containing %s", async (_label, name) => {
    // Control characters would corrupt the system prompt line and the
    // UI's agent card, so they're refused rather than stripped.
    const services = spawnServices();
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      { ...OK_INPUT, name },
    );
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_name");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("404s when the calling parent no longer exists", async () => {
    const services = spawnServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_t",
    });
  });

  it("enforces the per-parent daily cap of 8", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: {
        countByParentSince: vi.fn(async () => 8),
      },
    });
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    // A 24h window, in seconds.
    expect(
      services.agentProvisionEventRepo.countByParentSince,
    ).toHaveBeenCalledWith("agent_t", 86_400);
  });

  it("allows the 8th spawn when 7 are already in the window", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBeFalsy();
  });

  it("envelopes a failure from the agent insert", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "agent_t" })),
        create: vi.fn(async () => {
          throw new Error("unique violation on name");
        }),
      },
    });
    const res = await callTool(
      spawnTools(services),
      "create_subordinate_agent",
      OK_INPUT,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "unique violation on name" });
    expect(services.coreMemoryRepo.updateContent).not.toHaveBeenCalled();
  });

  it("carries the IC block descriptions into the tool's own schema", () => {
    // The per-field guidance and the <core_memory> block descriptions
    // share one source of truth; a drift here means the agent is told
    // two different things about the same field.
    const tool = findTool(spawnTools(spawnServices()), "create_subordinate_agent");
    const props = tool.schema.properties as Record<string, { description: string }>;
    const icBlocks = new Map(
      DEFAULT_BLOCK_TEMPLATES.ic.map((t) => [t.block_name, t.description]),
    );
    for (const field of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(props[field]?.description).toBe(icBlocks.get(field) ?? "");
    }
    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
  });
});
