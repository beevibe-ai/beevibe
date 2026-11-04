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

function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    negotiation_id: "neg_1",
    initiator_session_id: "sess_i",
    counterparty_session_id: "sess_c",
    summary: "We're stuck on scope",
    initiator_open_questions: [],
    counterparty_open_questions: [],
    escalated_by_role: "initiator",
    status: "pending",
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
    // provisionAgent (the real one — create_subordinate_agent calls it
    // directly) writes through these two.
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

// ── revise_task ──────────────────────────────────────────────────────────

describe("revise_task", () => {
  /** A blocked task assigned to a real direct subordinate of agent_t. */
  function parentOfBlocked(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    return buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_1", status: "blocked", assignee_id: "sub_1" }),
        ),
        ...overrides.taskRepo,
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", hierarchy_level: "ic", parent_agent_id: "agent_t" }),
        ),
        ...overrides.agentRepo,
      },
      ...overrides,
    });
  }

  const ctx = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  it("revises the task and reports the status transition", async () => {
    const services = parentOfBlocked();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "the API moved to /v2 — retry there",
    });

    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "the API moved to /v2 — retry there",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_1",
      // Post-#186 the task stays at needs_revision until the daemon
      // claims the dispatched session.
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("dispatches a revision session reusing the stamped next_dispatch_context", async () => {
    const reason = {
      kind: "revision" as const,
      feedback: "retry on /v2",
      from_status: "blocked" as const,
      source: "parent_agent" as const,
    };
    const services = parentOfBlocked({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "task_1",
            status: "needs_revision",
            assignee_id: "sub_1",
            next_dispatch_context: reason,
          }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "revise_task", { task_id: "task_1", feedback: "retry on /v2" });

    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      agentId: "sub_1",
      type: "task",
      reason,
    });
    expect(typeof arg?.intent).toBe("string");
  });

  it("skips the dispatch when no revision context was stamped", async () => {
    const services = parentOfBlocked({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ id: "task_1", status: "needs_revision", assignee_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "retry",
    });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { feedback: "f" }],
    ["a missing feedback", { task_id: "task_1" }],
    ["an empty feedback", { task_id: "task_1", feedback: "" }],
  ])("refuses %s", async (_label, input) => {
    const services = parentOfBlocked();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and feedback required" });
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("reports task_not_found for an unknown task", async () => {
    const services = buildServices({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "nope",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_not_found", task_id: "nope" });
  });

  it("reports task_unassigned when the task has no assignee", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "blocked", assignee_id: undefined })),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_unassigned" });
  });

  it("reports assignee_not_found when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "blocked", assignee_id: "sub_1" })),
      },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "assignee_not_found" });
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "blocked", assignee_id: "sub_1" })),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "someone_else" }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a grandchild — authz is direct-parent only", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ status: "blocked", assignee_id: "grandchild" })),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          // Parented by the caller's own subordinate, not by the caller.
          fakeAgent({ id: "grandchild", parent_agent_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.content).toMatchObject({ error: "not_parent" });
  });

  it("maps InvalidTaskTransitionError to invalid_transition", async () => {
    const services = parentOfBlocked({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "cannot revise a task in status done",
          );
        }),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_transition" });
    expect(String((result.content as { message: string }).message)).toBeTruthy();
  });

  it("falls back to the catch-all envelope for an unexpected throw", async () => {
    const services = parentOfBlocked({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("pool exhausted");
        }),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "pool exhausted" });
  });
});

// ── add_to_escalation ────────────────────────────────────────────────────

describe("add_to_escalation", () => {
  const ctx = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  it("submits the caller's slot and notifies listeners", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "B", description: "do B" }],
      open_questions: ["what is the SLA?"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals: [{ title: "B", description: "do B" }],
      openQuestions: ["what is the SLA?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });
  });

  it("reports both_sides_submitted once each slot has a timestamp", async () => {
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
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
  });

  it("is still false when only the initiator has submitted", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect(result.content).toMatchObject({ both_sides_submitted: false });
  });

  it.each([
    ["a missing escalation_id", {}],
    ["an empty escalation_id", { escalation_id: "" }],
  ])("refuses %s", async (_label, input) => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(
      tools,
      "add_to_escalation",
      input as Record<string, unknown>,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["a non-array", "A then B"],
  ])("leaves proposals and open_questions unset when %s", async (_label, value) => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: value,
      open_questions: value,
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("keeps only the string entries of open_questions", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real", 5, null, "also real"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real", "also real"] }),
    );
  });

  it("envelopes a double-submit refusal from the service", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("caller already submitted");
        }),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "caller already submitted" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent ─────────────────────────────────────────────

describe("create_subordinate_agent", () => {
  const ctx = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  /** A caller that resolves to a real parent row. */
  function withParent(
    parent: Partial<Agent> = {},
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", owner_id: "person_1", ...parent }),
        ),
        ...overrides.agentRepo,
      },
      ...overrides,
    });
  }

  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, terse, test-first.",
    domain: "Express + Postgres",
  };

  it("provisions an IC under the caller and returns the new id", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    const created = (result.content as { created: Record<string, unknown> }).created;
    expect(created).toMatchObject({
      name: "Backend specialist",
      hierarchy_level: "ic",
      parent_agent_id: "agent_t",
    });
    expect(typeof created.id).toBe("string");

    // provisionAgent writes through agentRepo.create.
    const createArg = vi.mocked(services.agentRepo.create).mock.calls[0]?.[0];
    expect(createArg).toMatchObject({
      name: "Backend specialist",
      owner_id: "person_1",
      parent_agent_id: "agent_t",
      hierarchy_level: "ic",
    });
  });

  it("inherits the parent's runtime config but overwrites the name prompt", async () => {
    const services = withParent({
      runtime_config: { type: "claude", model: "opus", system_prompt_addition: "You are A." },
    });
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "create_subordinate_agent", VALID);

    const createArg = vi.mocked(services.agentRepo.create).mock.calls[0]?.[0];
    expect(createArg?.runtime_config).toMatchObject({
      model: "opus",
      system_prompt_addition: "You are Backend specialist.",
    });
  });

  it("pins the child to the parent's preferred runtime when it has one", async () => {
    const services = withParent({ preferred_runtime_id: "rt_1" });
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "create_subordinate_agent", VALID);

    expect(vi.mocked(services.agentRepo.create).mock.calls[0]?.[0]).toMatchObject({
      preferred_runtime_id: "rt_1",
    });
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = withParent({ preferred_runtime_id: undefined });
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "create_subordinate_agent", VALID);

    expect(
      vi.mocked(services.agentRepo.create).mock.calls[0]?.[0],
    ).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds the three required identity blocks and skips the empty optional ones", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "create_subordinate_agent", VALID);

    const written = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(written).toEqual(
      expect.arrayContaining([
        ["tag_line", "Owns the API surface"],
        ["persona", "Pragmatic, terse, test-first."],
        ["domain", "Express + Postgres"],
      ]),
    );
    expect(written.map((w) => w[0])).not.toContain("active_context");
    expect(written.map((w) => w[0])).not.toContain("constraints");
  });

  it("seeds the optional blocks when the parent supplies them", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      active_context: "Migrating auth to OIDC",
      constraints: "No breaking API changes",
    });

    const written = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(written).toEqual(
      expect.arrayContaining([
        ["active_context", "Migrating auth to OIDC"],
        ["constraints", "No breaking API changes"],
      ]),
    );
  });

  it("writes the audit row that backs the daily cap", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);
    const created = (result.content as { created: { id: string } }).created;

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        child_agent_id: created.id,
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: "Pragmatic, terse, test-first.",
        domain: "Express + Postgres",
      }),
    );
  });

  it("still succeeds when the audit row fails to write", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = withParent(
      {},
      {
        agentProvisionEventRepo: {
          create: vi.fn(async () => {
            throw new Error("audit table locked");
          }),
        },
      },
    );
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    // The agent + its memory are the user-visible artifacts; the audit
    // row is best-effort.
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveProperty("created");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("is never handed to an IC tier caller", () => {
    const services = withParent();
    // The handler also guards on ctx.hierarchyLevel === "ic", but that
    // branch is defense-in-depth: the builder never puts this tool in the
    // IC set, so an IC caller cannot reach the handler at all.
    expect(
      buildHierarchyTools({ agentId: "agent_i", hierarchyLevel: "ic" }, services).map(
        (t) => t.name,
      ),
    ).not.toContain("create_subordinate_agent");
  });

  it.each([
    ["name", { ...VALID, name: "" }],
    ["tag_line", { ...VALID, tag_line: "   " }],
    ["persona", { ...VALID, persona: "" }],
    ["domain", { ...VALID, domain: undefined }],
  ])("refuses a blank %s", async (_field, input) => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      input as Record<string, unknown>,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("refuses a tag_line over 100 chars and reports the actual length", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
  });

  it("accepts a tag_line of exactly 100 chars", async () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(100),
    });

    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["a control character", "Backend\u0000specialist"],
    ["a newline", "Backend\nspecialist"],
  ])("refuses a name with %s", async (_label, name) => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", { ...VALID, name });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("reports parent_not_found when the caller row is missing", async () => {
    const services = buildServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_t",
    });
  });

  it("enforces the per-parent daily cap", async () => {
    const services = withParent(
      { name: "Team lead" },
      { agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) } },
    );
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    // The cap window is 24h expressed in seconds.
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      86_400,
    );
  });

  it("allows the spawn one under the cap", async () => {
    const services = withParent(
      {},
      { agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) } },
    );
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("envelopes a failure from provisionAgent", async () => {
    const services = withParent(
      {},
      {
        agentRepo: {
          findById: vi.fn(async () => fakeAgent({ id: "agent_t", owner_id: "person_1" })),
          create: vi.fn(async () => {
            throw new Error("duplicate agent name");
          }),
        },
      },
    );
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "duplicate agent name" });
  });

  it("borrows its field descriptions from the IC block templates", () => {
    const services = withParent();
    const tools = buildHierarchyTools(ctx, services);
    const schema = findTool(tools, "create_subordinate_agent").schema as {
      properties: Record<string, { description: string }>;
      required: string[];
    };

    expect(schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
    // Sourced from DEFAULT_BLOCK_TEMPLATES.ic, so they can't be empty.
    for (const field of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(schema.properties[field]?.description).toBeTruthy();
    }
  });
});
