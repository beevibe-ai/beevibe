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
    initiator_session_id: "sess_i",
    counterparty_session_id: "sess_c",
    summary: "We disagree on the rollout date.",
    initiator_open_questions: [],
    counterparty_open_questions: [],
    escalated_by_role: "initiator",
    status: "pending",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Escalation;
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
    // provisionAgent (create_subordinate_agent) seeds the new IC's blocks
    // through this before the tool overwrites the identity-bearing ones.
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
  const blockedTask = () =>
    fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" });

  function reviseServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    return buildServices({
      taskRepo: { findById: vi.fn(async () => blockedTask()) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", hierarchy_level: "ic", parent_agent_id: "agent_t" }),
        ),
      },
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "task_b",
            status: "needs_revision",
            assignee_id: "sub_1",
            next_dispatch_context: {
              kind: "revision",
              feedback: "try the staging creds",
              from_status: "blocked",
              source: "parent_agent",
            },
          }),
        ),
      },
      ...overrides,
    });
  }

  it("revises the subordinate's task and dispatches the revision session", async () => {
    const services = reviseServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "try the staging creds",
    });

    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_b",
      "try the staging creds",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledOnce();
    const dispatched = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]![0];
    expect(dispatched).toMatchObject({
      agentId: "sub_1",
      type: "task",
      reason: { kind: "revision", from_status: "blocked" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      revised: true,
      task_id: "task_b",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips the dispatch when reviseTask left no revision context", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "needs_revision", assignee_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { feedback: "f" }],
    ["no feedback", { task_id: "task_b" }],
  ])("refuses %s", async (_label, input) => {
    const services = reviseServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and feedback required" });
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("reports task_not_found for an unknown task", async () => {
    const services = reviseServices({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "nope", feedback: "f" });
    expect(result.content).toMatchObject({ error: "task_not_found", task_id: "nope" });
  });

  it("reports task_unassigned when the task has no assignee", async () => {
    const services = reviseServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: undefined })) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });
    expect(result.content).toMatchObject({ error: "task_unassigned" });
  });

  it("reports assignee_not_found when the assignee row is gone", async () => {
    const services = reviseServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });
    expect(result.content).toMatchObject({ error: "assignee_not_found" });
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const services = reviseServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "sub_1", parent_agent_id: "someone_else" })),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps an InvalidTaskTransitionError to invalid_transition", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("cannot revise a done task");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_transition",
      message: "cannot revise a done task",
    });
  });

  it("degrades any other throw to the catch-all envelope", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("pool exhausted");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });
    expect(result.content).toEqual({ error: "pool exhausted" });
  });
});

describe("add_to_escalation", () => {
  it("adds the caller's contribution and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "Ship behind a flag", description: "gate it" }],
      open_questions: ["is the customer flexible?", 42],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals: [{ title: "Ship behind a flag", description: "gate it" }],
      // non-string questions are dropped rather than forwarded
      openQuestions: ["is the customer flexible?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("escalation_updated"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      // only one side has submitted
      both_sides_submitted: false,
    });
  });

  it("reports both_sides_submitted once the counterparty has filed too", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({
            status: "resolved",
            initiator_submitted_at: new Date("2026-04-01"),
            counterparty_submitted_at: new Date("2026-04-02"),
          }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(result.content).toMatchObject({ both_sides_submitted: true });
  });

  it("leaves proposals and open_questions undefined when they are not arrays", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "one option",
      open_questions: "a question",
    });

    expect(vi.mocked(services.escalationService.addContribution).mock.calls[0]![0]).toMatchObject({
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("refuses a missing escalation_id without calling the service", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("does not notify when the contribution fails", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("already submitted");
        }),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(result.content).toEqual({ error: "already submitted" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

describe("create_subordinate_agent", () => {
  const GOOD = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, test-first.",
    domain: "Express + Postgres",
  };

  function spawnServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
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
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
      ...overrides,
    });
  }

  function toolsFor(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  /** What the tool actually handed provisionAgent, via agentRepo.create. */
  function createdRow(services: ReturnType<typeof buildServices>) {
    return vi.mocked(services.agentRepo.create).mock.calls[0]![0];
  }

  it("provisions the IC under the caller, inheriting owner and runtime", async () => {
    const services = spawnServices();
    const result = await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(result.isError).toBeFalsy();
    expect(createdRow(services)).toMatchObject({
      name: GOOD.name,
      owner_id: "person_1",
      parent_agent_id: "agent_t",
      hierarchy_level: "ic",
    });
    // Parent's runtime carries over; only the identity line is replaced.
    expect(createdRow(services).runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      system_prompt_addition: `You are ${GOOD.name}.`,
    });
    expect(result.content).toMatchObject({
      created: { hierarchy_level: "ic", parent_agent_id: "agent_t" },
    });
  });

  it("pins the child to the parent's runtime when the parent has one", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "agent_t", preferred_runtime_id: "rt_1" })),
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
    });
    await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(createdRow(services)).toMatchObject({ preferred_runtime_id: "rt_1" });
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = spawnServices();
    await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(createdRow(services)).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds only the three required blocks when the optional ones are blank", async () => {
    const services = spawnServices();
    await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => c[1])
      .sort();
    expect(seeded).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds active_context and constraints when supplied", async () => {
    const services = spawnServices();
    await callTool(toolsFor(services), "create_subordinate_agent", {
      ...GOOD,
      active_context: "Migrating auth to OIDC",
      constraints: "No breaking API changes",
    });

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(seeded).toEqual(
      expect.arrayContaining([
        ["active_context", "Migrating auth to OIDC"],
        ["constraints", "No breaking API changes"],
      ]),
    );
  });

  it("writes the provision audit row", async () => {
    const services = spawnServices();
    await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(vi.mocked(services.agentProvisionEventRepo.create).mock.calls[0]![0]).toMatchObject({
      parent_agent_id: "agent_t",
      owner_person_id: "person_1",
      child_name: GOOD.name,
      persona: GOOD.persona,
      domain: GOOD.domain,
    });
  });

  it("still succeeds when the audit row fails to write", async () => {
    const services = spawnServices();
    vi.mocked(services.agentProvisionEventRepo.create).mockRejectedValueOnce(
      new Error("audit table locked"),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(result.isError).toBeFalsy();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("is not offered to ICs at all — the tier gate is in the tool set", () => {
    const services = spawnServices();
    const icTools = buildHierarchyTools({ agentId: "agent_i", hierarchyLevel: "ic" }, services);
    expect(icTools.map((t) => t.name)).not.toContain("create_subordinate_agent");
  });

  it.each([
    ["name", { ...GOOD, name: "  " }],
    ["tag_line", { ...GOOD, tag_line: "" }],
    ["persona", { ...GOOD, persona: "" }],
    ["domain", { ...GOOD, domain: "" }],
  ])("refuses a blank %s", async (_field, input) => {
    const services = spawnServices();
    const result = await callTool(toolsFor(services), "create_subordinate_agent", input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("refuses a tag_line over 100 chars and reports the actual length", async () => {
    const services = spawnServices();
    const result = await callTool(toolsFor(services), "create_subordinate_agent", {
      ...GOOD,
      tag_line: "x".repeat(101),
    });

    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["containing a control character", "Backend\u0001specialist"],
  ])("refuses a name %s", async (_label, name) => {
    const services = spawnServices();
    const result = await callTool(toolsFor(services), "create_subordinate_agent", {
      ...GOOD,
      name,
    });

    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("reports parent_not_found when the caller's row is gone", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () => undefined),
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
    });
    const result = await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(result.content).toMatchObject({ error: "parent_not_found", agent_id: "agent_t" });
  });

  it("counts recent spawns over a 24h window", async () => {
    const services = spawnServices();
    await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      24 * 60 * 60,
    );
  });

  it("enforces the per-parent daily cap", async () => {
    const services = spawnServices();
    vi.mocked(services.agentProvisionEventRepo.countByParentSince).mockResolvedValueOnce(8);

    const result = await callTool(toolsFor(services), "create_subordinate_agent", GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("degrades a provisioning throw to the catch-all envelope", async () => {
    const services = spawnServices();
    vi.mocked(services.agentRepo.create).mockRejectedValueOnce(new Error("duplicate name"));

    const result = await callTool(toolsFor(services), "create_subordinate_agent", GOOD);
    expect(result.content).toEqual({ error: "duplicate name" });
  });

  it("takes its field descriptions from the IC core-memory block templates", () => {
    const tool = findTool(toolsFor(spawnServices()), "create_subordinate_agent");
    const props = tool.schema.properties as Record<string, { description: string }>;

    for (const block of ["tag_line", "persona", "domain"]) {
      expect(props[block]!.description.length).toBeGreaterThan(0);
    }
    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
  });
});
