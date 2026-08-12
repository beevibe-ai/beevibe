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

function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    negotiation_id: "neg_1",
    initiator_session_id: "sess_a",
    counterparty_session_id: "sess_b",
    summary: "Two owners disagree on the rollout order",
    initiator_open_questions: [],
    counterparty_open_questions: [],
    escalated_by_role: "initiator",
    status: "pending",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
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
  pool?: Partial<Pool>;
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    create: vi.fn(async (input: Parameters<AgentRepository["create"]>[0]) =>
      fakeAgent(input as Partial<Agent>),
    ),
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
    addContribution: vi.fn(async () => fakeEscalation()),
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
    ...overrides.pool,
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

// ── revise_task (M6.4) ───────────────────────────────────────────────────
//
// The parent-only unblock path. Two things are worth pinning: the authz
// ladder (each rung returns its own code, and none of them reach
// taskService), and the dispatch that only fires when reviseTask actually
// stamped a `revision` next_dispatch_context.

describe("revise_task", () => {
  /** Assignee whose parent is the caller — the happy-path authz shape. */
  function subordinateOf(parentId: string): Agent {
    return fakeAgent({ id: "sub_1", hierarchy_level: "ic", parent_agent_id: parentId });
  }

  it("revises a blocked subordinate task and dispatches the revision session", async () => {
    const blocked = fakeTask({ id: "task_1", status: "blocked", assignee_id: "sub_1" });
    const revised = fakeTask({
      id: "task_1",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "try the other API",
        source: "parent_agent",
        from_status: "blocked",
      },
    });
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => blocked) },
      agentRepo: { findById: vi.fn(async () => subordinateOf("agent_t")) },
      taskService: { reviseTask: vi.fn(async () => revised) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "try the other API",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_1",
      status: "needs_revision",
      from_status: "blocked",
    });
    expect(services.taskService.reviseTask).toHaveBeenCalledWith("task_1", "try the other API", {
      source: "parent_agent",
      reviserAgentId: "agent_t",
    });
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sub_1",
        type: "task",
        reason: {
          kind: "revision",
          feedback: "try the other API",
          source: "parent_agent",
          from_status: "blocked",
        },
      }),
    );
  });

  it("skips the dispatch when reviseTask left no revision context", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "blocked", assignee_id: "sub_1" })),
      },
      agentRepo: { findById: vi.fn(async () => subordinateOf("agent_t")) },
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ status: "needs_revision", assignee_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "go on" });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { feedback: "f" }],
    ["a missing feedback", { task_id: "task_1" }],
  ])("rejects %s without touching the repos", async (_label, input) => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", input);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_id and feedback required");
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s on an unknown task", async () => {
    const services = buildServices({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "nope", feedback: "f" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_not_found", task_id: "nope" });
  });

  it("rejects an unassigned task — there is no subordinate to unblock", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: undefined })) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "ghost" })) },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("assignee_not_found");
  });

  it("rejects a caller who is not the assignee's direct parent", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1" })) },
      agentRepo: { findById: vi.fn(async () => subordinateOf("someone_else")) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("not_parent");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps InvalidTaskTransitionError to a coded result, not a raw throw", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "done", assignee_id: "sub_1" })),
      },
      agentRepo: { findById: vi.fn(async () => subordinateOf("agent_t")) },
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("cannot revise from done");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_transition",
      message: "cannot revise from done",
    });
  });

  it("falls back to the generic envelope for an unexpected throw", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("db down");
  });
});

// ── add_to_escalation (M6.4) ─────────────────────────────────────────────

describe("add_to_escalation", () => {
  it("forwards proposals + open questions and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({
            initiator_submitted_at: new Date("2026-04-01"),
            counterparty_submitted_at: new Date("2026-04-02"),
          }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "Ship it", description: "behind a flag" }],
      open_questions: ["who owns rollback?", 42],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals: [{ title: "Ship it", description: "behind a flag" }],
      // The non-string entry is dropped rather than passed through.
      openQuestions: ["who owns rollback?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(expect.stringContaining("pg_notify"), [
      "esc_1",
    ]);
  });

  it("passes undefined (not []) when the optional arrays are absent", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("reports both_sides_submitted=false while one slot is still empty", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect((result.content as { both_sides_submitted: boolean }).both_sides_submitted).toBe(false);
  });

  it("rejects a missing escalation_id before calling the service", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("escalation_id required");
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("envelopes a service throw instead of propagating it", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("already submitted");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("already submitted");
    // The notify only fires on a successful contribution.
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent (Phase 9) ───────────────────────────────────

describe("create_subordinate_agent", () => {
  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, tests first",
    domain: "Express + Postgres",
  };

  /** A resolvable team parent for the tool to inherit owner + runtime from. */
  function parentServices(
    parent: Partial<Agent> = {},
    overrides: Parameters<typeof buildServices>[0] = {},
  ) {
    return buildServices({
      ...overrides,
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_t",
            name: "Team lead",
            owner_id: "person_1",
            runtime_config: { type: "claude", model: "opus" },
            ...parent,
          }),
        ),
        ...overrides.agentRepo,
      },
    });
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("provisions an IC under the caller, inheriting owner + runtime", async () => {
    const services = parentServices();

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Backend specialist",
        owner_id: "person_1",
        parent_agent_id: "agent_t",
        hierarchy_level: "ic",
        runtime_config: expect.objectContaining({
          model: "opus",
          system_prompt_addition: "You are Backend specialist.",
        }),
      }),
    );
    expect((result.content as { created: Record<string, unknown> }).created).toMatchObject({
      hierarchy_level: "ic",
      parent_agent_id: "agent_t",
    });
  });

  it("seeds the required core-memory blocks and skips the empty optional ones", async () => {
    const services = parentServices();

    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    const written = (
      services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[1] as string);
    expect(written.sort()).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds active_context and constraints when the parent supplies them", async () => {
    const services = parentServices();

    await callTool(teamTools(services), "create_subordinate_agent", {
      ...VALID,
      active_context: "Migrating auth to JWT",
      constraints: "No breaking API changes",
    });

    const written = (
      services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[1] as string);
    expect(written.sort()).toEqual([
      "active_context",
      "constraints",
      "domain",
      "persona",
      "tag_line",
    ]);
  });

  it("inherits the parent's preferred runtime so the child lands on the same daemon", async () => {
    const services = parentServices({ preferred_runtime_id: "rt_laptop" });

    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_runtime_id: "rt_laptop" }),
    );
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    const services = parentServices();

    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    const input = (services.agentRepo.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input).not.toHaveProperty("preferred_runtime_id");
  });

  it("writes the provision audit row", async () => {
    const services = parentServices();

    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: "Pragmatic, tests first",
        domain: "Express + Postgres",
      }),
    );
  });

  it("still returns the created agent when the audit row fails to write", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = parentServices(
      {},
      {
        agentProvisionEventRepo: {
          create: vi.fn(async () => {
            throw new Error("audit table missing");
          }),
        },
      },
    );

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect((result.content as { created: unknown }).created).toBeDefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    ["name", { ...VALID, name: "  " }],
    ["tag_line", { ...VALID, tag_line: "" }],
    ["persona", { ...VALID, persona: "" }],
    ["domain", { ...VALID, domain: "" }],
  ])("rejects a blank %s", async (_field, input) => {
    const services = parentServices();

    const result = await callTool(teamTools(services), "create_subordinate_agent", input);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("missing_required_fields");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a tag_line over 100 chars", async () => {
    const services = parentServices();

    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["carrying a NUL", `Backend${String.fromCharCode(0)}specialist`],
    ["carrying a newline", "Backend\nspecialist"],
    ["carrying DEL", `Backend${String.fromCharCode(127)}`],
  ])("rejects a name %s", async (_label, name) => {
    const services = parentServices();

    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...VALID,
      name,
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("invalid_name");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a name at exactly the 80-char boundary", async () => {
    const services = parentServices();

    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...VALID,
      name: "n".repeat(80),
    });

    expect(result.isError).toBeFalsy();
  });

  it("404s when the calling parent's row is gone", async () => {
    const services = buildServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools({ agentId: "ghost", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "parent_not_found", agent_id: "ghost" });
  });

  it("enforces the per-parent daily spawn cap", async () => {
    const services = parentServices(
      {},
      { agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) } },
    );

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      24 * 60 * 60,
    );
  });

  it("still spawns on the last slot under the cap", async () => {
    const services = parentServices(
      {},
      { agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) } },
    );

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalled();
  });

  it("envelopes a provisioning throw instead of propagating it", async () => {
    const services = parentServices(
      {},
      {
        agentRepo: {
          create: vi.fn(async () => {
            throw new Error("unique violation on agent.name");
          }),
        },
      },
    );

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("unique violation on agent.name");
  });
});

// ── Remaining validation guards ──────────────────────────────────────────

describe("argument validation on the shared tools", () => {
  const icCtx = { agentId: "agent_i", hierarchyLevel: "ic" as const };

  it("get_task projects the full task when one is found", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({
            id: "task_9",
            description: "do the thing",
            assignee_id: "sub_1",
            result_summary: "shipped",
            blocker_agent_id: "agent_t",
            blocker_reason: "needs creds",
            repo_url: "https://github.com/acme/app",
          }),
        ),
      },
    });
    const tools = buildHierarchyTools(icCtx, services);

    const result = await callTool(tools, "get_task", { task_id: "task_9" });

    expect(result.content).toEqual({
      task: {
        id: "task_9",
        title: "Build X",
        description: "do the thing",
        status: "in_progress",
        priority: "medium",
        assignee_id: "sub_1",
        creator_id: "agent_a",
        creator_type: "agent",
        parent_task_id: null,
        repo_url: "https://github.com/acme/app",
        result_summary: "shipped",
        blocker_agent_id: "agent_t",
        blocker_reason: "needs creds",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
    });
  });

  it.each([
    ["get_agent_profile", { agent_id: "" }, "agent_id required"],
    ["get_task", { task_id: "" }, "task_id required"],
    ["list_work_products", { task_id: "" }, "task_id required"],
    ["get_work_product", { id: "" }, "id required"],
    ["update_work_product", { id: "" }, "id required"],
    [
      "create_work_product",
      { task_id: "t", type: "pull_request", title: "" },
      "task_id and title required",
    ],
  ])("%s rejects a blank identifier", async (tool, input, message) => {
    const tools = buildHierarchyTools(icCtx, buildServices());

    const result = await callTool(tools, tool, input);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe(message);
  });

  it("create_work_product forwards a metadata object and drops a non-object one", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(icCtx, services);

    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      type: "pull_request",
      title: "PR",
      metadata: { pr_number: 12 },
    });
    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      type: "pull_request",
      title: "PR",
      metadata: "not-an-object",
    });

    const calls = (services.taskService.createWorkProduct as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({ metadata: { pr_number: 12 } });
    expect(calls[1]![0].metadata).toBeUndefined();
  });

  it("update_work_product forwards a metadata object and drops a non-object one", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(icCtx, services);

    await callTool(tools, "update_work_product", { id: "wp_1", metadata: { rev: 2 } });
    await callTool(tools, "update_work_product", { id: "wp_1", metadata: 7 });

    const calls = (services.taskService.updateWorkProduct as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toMatchObject({ metadata: { rev: 2 } });
    expect(calls[1]![1].metadata).toBeUndefined();
  });

  it("create_task rejects a missing intent or agent_id before the authz lookup", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", { intent: "x" });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("intent and agent_id required");
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("create_task rejects an out-of-range priority after authorizing the assignee", async () => {
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "x",
      agent_id: "sub_1",
      priority: "yesterday",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toMatch(/^priority must be one of:/);
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

// ── Error envelopes ──────────────────────────────────────────────────────
//
// Every handler wraps its body in try/catch so an infrastructure failure
// reaches the agent as a tool result it can reason about, rather than
// tearing down the MCP call. One case per handler — the envelope is the
// contract, and a handler that grows a new early `return` outside the try
// is exactly what this catches.

describe("unexpected throws are enveloped, never propagated", () => {
  const boom = () =>
    vi.fn(async () => {
      throw new Error("boom");
    });

  it.each([
    ["search_context", { memoryAgent: { searchArchival: boom() } }, { query: "q" }],
    ["update_progress", { taskService: { updateProgress: boom() } }, { task_id: "t", status: "done", summary: "s" }],
    ["find_up", { agentRepo: { findParent: boom() } }, {}],
    ["get_agent_profile", { agentRepo: { findById: boom() } }, { agent_id: "a" }],
    ["get_task", { taskRepo: { findById: boom() } }, { task_id: "t" }],
    ["create_work_product", { taskService: { createWorkProduct: boom() } }, { task_id: "t", type: "pull_request", title: "T" }],
    ["list_work_products", { taskService: { listWorkProducts: boom() } }, { task_id: "t" }],
    ["get_work_product", { taskService: { getWorkProduct: boom() } }, { id: "wp_1" }],
    ["update_work_product", { taskService: { updateWorkProduct: boom() } }, { id: "wp_1" }],
    ["find_subordinates", { agentRepo: { findSubordinates: boom() } }, {}],
    ["find_peers", { agentRepo: { findPeers: boom() } }, {}],
    ["create_task", { agentRepo: { findSubordinates: boom() } }, { intent: "x", agent_id: "sub_1" }],
    ["check_work_status", { taskRepo: { listByAssignee: boom() } }, { agent_id: "agent_t" }],
  ])("%s", async (tool, overrides, input) => {
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      buildServices(overrides),
    );

    const result = await callTool(tools, tool, input);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("boom");
  });
});
