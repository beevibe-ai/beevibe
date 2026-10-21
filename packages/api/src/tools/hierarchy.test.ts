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

function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    negotiation_id: "neg_1",
    initiator_session_id: "sess_a",
    counterparty_session_id: "sess_b",
    summary: "Who owns the retry queue?",
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
    initDefaults: vi.fn(async () => []),
    updateContent: vi.fn(async () => undefined),
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
  function reviseServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    return buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_1", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "sub_1", parent_agent_id: "agent_p" })),
      },
      ...overrides,
    });
  }

  function reviseTools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_p", hierarchyLevel: "team" }, services);
  }

  it("revises the task and dispatches the revision session", async () => {
    const revised = fakeTask({
      id: "task_1",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the retry helper",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: "agent_p",
      },
    });
    const services = reviseServices({ taskService: { reviseTask: vi.fn(async () => revised) } });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "use the retry helper",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_1",
      // Stays at needs_revision until the daemon claims the session.
      status: "needs_revision",
      from_status: "blocked",
    });
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the retry helper",
      { source: "parent_agent", reviserAgentId: "agent_p" },
    );
    // The stamped next_dispatch_context is reused verbatim as the
    // ResumeReason, so the revision narrative survives into the session.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: revised,
        agentId: "sub_1",
        type: "task",
        reason: revised.next_dispatch_context,
      }),
    );
  });

  // A post_escalation context (or none at all) means this isn't a
  // revision dispatch — reviseTask still succeeded, so report success
  // without spawning a session.
  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => fakeTask({ id: "task_1", status: "needs_revision" })),
      },
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "try again",
    });

    expect(result.isError).toBeFalsy();
    expect((result.content as { revised: boolean }).revised).toBe(true);
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["no task_id", { feedback: "f" }],
    ["no feedback", { task_id: "task_1" }],
    ["an empty feedback", { task_id: "task_1", feedback: "" }],
  ])("rejects a call with %s", async (_label, input) => {
    const services = reviseServices();
    const result = await callTool(reviseTools(services), "revise_task", input);

    expect(result.isError).toBe(true);
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("404s on an unknown task", async () => {
    const services = reviseServices({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_gone",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_not_found", task_id: "task_gone" });
  });

  it("rejects an unassigned task — there is nobody to re-dispatch to", async () => {
    const services = reviseServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ id: "task_1", assignee_id: undefined })),
      },
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
  });

  it("errors when the assignee has since been deleted", async () => {
    const services = reviseServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("assignee_not_found");
  });

  // Authz: only the assignee's *direct* parent can unblock it. A team
  // agent elsewhere in the tree must not be able to steer someone
  // else's subordinate.
  it("refuses a caller who is not the assignee's direct parent", async () => {
    const services = reviseServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_other" }),
        ),
      },
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("not_parent");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps an invalid transition onto the invalid_transition code", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("cannot revise a done task");
        }),
      },
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_transition",
      message: "cannot revise a done task",
    });
  });

  it("falls back to the catch-all envelope for an unexpected throw", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("pool exhausted");
        }),
      },
    });
    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "pool exhausted" });
  });
});

describe("add_to_escalation", () => {
  function escTools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_b", hierarchyLevel: "team" }, services);
  }

  it("submits the caller's proposals and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ counterparty_submitted_at: new Date("2026-04-02") }),
        ),
      },
    });
    const proposals = [{ title: "Split the queue", description: "Two topics", tradeoffs: "more ops" }];
    const result = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["Who owns retries?"],
    });

    expect(result.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_b",
      proposals,
      openQuestions: ["Who owns retries?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
  });

  // both_sides_submitted is what tells the UI the escalation is ready
  // for a human to read; it needs BOTH timestamps, not either one.
  it("reports both_sides_submitted only when both timestamps are set", async () => {
    async function bothFor(patch: Partial<Escalation>): Promise<boolean> {
      const services = buildServices({
        escalationService: {
          addContribution: vi.fn(async () => fakeEscalation(patch)),
        },
      });
      const result = await callTool(escTools(services), "add_to_escalation", {
        escalation_id: "esc_1",
      });
      return (result.content as { both_sides_submitted: boolean }).both_sides_submitted;
    }

    expect(await bothFor({})).toBe(false);
    expect(await bothFor({ initiator_submitted_at: new Date() })).toBe(false);
    expect(await bothFor({ counterparty_submitted_at: new Date() })).toBe(false);
    expect(
      await bothFor({
        initiator_submitted_at: new Date(),
        counterparty_submitted_at: new Date(),
      }),
    ).toBe(true);
  });

  it("rejects a missing escalation_id without calling the service", async () => {
    const services = buildServices();
    const result = await callTool(escTools(services), "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("treats non-array proposals and open_questions as absent", async () => {
    const services = buildServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "just split it",
      open_questions: "who owns retries?",
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("filters non-string open_questions out of the array", async () => {
    const services = buildServices();
    await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["Who owns retries?", 7, null],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["Who owns retries?"] }),
    );
  });

  it("surfaces a service refusal and skips the notify", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("caller's slot (counterparty) already submitted");
        }),
      },
    });
    const result = await callTool(escTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "caller's slot (counterparty) already submitted",
    });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

describe("create_subordinate_agent", () => {
  const BRIEFING = {
    name: "Backend specialist",
    tag_line: "Owns the API and its data layer",
    persona: "Pragmatic, test-first, allergic to premature abstraction",
    domain: "Express routes, Postgres schema, migrations",
  };

  function parentServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ): ReturnType<typeof buildServices> {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_p",
            name: "Team lead",
            owner_id: "person_1",
            hierarchy_level: "team",
            runtime_config: { type: "claude", model: "opus" },
            preferred_runtime_id: "rt_1",
          }),
        ),
        create: vi.fn(async (input: Parameters<AgentRepository["create"]>[0]) =>
          fakeAgent(input as Partial<Agent>),
        ),
      },
      ...overrides,
    });
  }

  function spawnTools(
    services: ReturnType<typeof buildServices>,
    level: HierarchyLevel = "team",
  ): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_p", hierarchyLevel: level }, services);
  }

  it("provisions an IC under the caller, inheriting owner and runtime", async () => {
    const services = parentServices();
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: BRIEFING.name,
        owner_id: "person_1",
        parent_agent_id: "agent_p",
        hierarchy_level: "ic",
        // Same human, same machine: the child runs on the parent's daemon.
        preferred_runtime_id: "rt_1",
        runtime_config: {
          type: "claude",
          model: "opus",
          // The name goes in the system prompt; the persona description
          // lives in core memory and isn't duplicated here.
          system_prompt_addition: "You are Backend specialist.",
        },
      }),
    );
    expect(result.content).toEqual({
      created: expect.objectContaining({
        name: BRIEFING.name,
        hierarchy_level: "ic",
        parent_agent_id: "agent_p",
      }),
    });
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_p", preferred_runtime_id: undefined }),
        ),
        create: vi.fn(async (input: Parameters<AgentRepository["create"]>[0]) =>
          fakeAgent(input as Partial<Agent>),
        ),
      },
    });
    await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    const created = (services.agentRepo.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(created).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds the three required identity blocks and skips the empty optional ones", async () => {
    const services = parentServices();
    await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    const written = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls;
    expect(written.map(([, block]) => block).sort()).toEqual([
      "domain",
      "persona",
      "tag_line",
    ]);
  });

  it("seeds active_context and constraints when the parent supplies them", async () => {
    const services = parentServices();
    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...BRIEFING,
      active_context: "Migrating the task table",
      constraints: "No breaking API changes",
    });

    const written = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls;
    expect(written.map(([, block]) => block).sort()).toEqual([
      "active_context",
      "constraints",
      "domain",
      "persona",
      "tag_line",
    ]);
  });

  it("writes the audit row that backs the daily cap and the audit panel", async () => {
    const services = parentServices();
    await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_p",
        owner_person_id: "person_1",
        child_name: BRIEFING.name,
        persona: BRIEFING.persona,
        domain: BRIEFING.domain,
      }),
    );
  });

  // The agent and its memory are the user-visible artifacts; losing the
  // audit row must not make the caller think the spawn failed.
  it("still reports success when the audit row fails to write", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = parentServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table is read-only");
        }),
      },
    });
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBeFalsy();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each(["name", "tag_line", "persona", "domain"] as const)(
    "rejects a briefing missing %s",
    async (field) => {
      const services = parentServices();
      const result = await callTool(spawnTools(services), "create_subordinate_agent", {
        ...BRIEFING,
        [field]: "   ",
      });

      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("missing_required_fields");
      expect(services.agentRepo.create).not.toHaveBeenCalled();
    },
  );

  it("rejects a tag_line over 100 chars so the agent card stays legible", async () => {
    const services = parentServices();
    const result = await callTool(spawnTools(services), "create_subordinate_agent", {
      ...BRIEFING,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "tag_line_too_long",
      message: "tag_line must be ≤100 chars",
      actual: 101,
    });
  });

  it.each([
    ["over 80 chars", "x".repeat(81)],
    ["a newline", "Backend\nspecialist"],
    ["a control character", "Backend\u0007specialist"],
  ])("rejects a name containing %s", async (_label, name) => {
    const services = parentServices();
    const result = await callTool(spawnTools(services), "create_subordinate_agent", {
      ...BRIEFING,
      name,
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("invalid_name");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts natural names with punctuation and ampersands", async () => {
    const services = parentServices();
    const result = await callTool(spawnTools(services), "create_subordinate_agent", {
      ...BRIEFING,
      name: "Web & Onboarding specialist (Auth/SSO)",
    });

    expect(result.isError).toBeFalsy();
  });

  it("errors when the caller's own agent row is gone", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () => undefined),
        create: vi.fn(async () => fakeAgent()),
      },
    });
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "parent_not_found", agent_id: "agent_p" });
  });

  // The cap exists to stop a runaway onboarding loop from spawning
  // dozens of specialists; it bites at 8 per parent per 24h.
  it("refuses once the parent has hit the daily cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_p",
      24 * 60 * 60,
    );
  });

  it("allows the spawn one under the cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("wraps a provisioning failure in the catch-all envelope", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "agent_p" })),
        create: vi.fn(async () => {
          throw new Error("duplicate agent name");
        }),
      },
    });
    const result = await callTool(spawnTools(services), "create_subordinate_agent", BRIEFING);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "duplicate agent name" });
  });

  // The per-field guidance and the <core_memory> block descriptions the
  // IC actually sees come from one source — DEFAULT_BLOCK_TEMPLATES.ic.
  it("pulls its field descriptions from the IC block templates", () => {
    const tool = spawnTools(parentServices()).find(
      (t) => t.name === "create_subordinate_agent",
    )!;
    const props = (tool.schema as { properties: Record<string, { description: string }> })
      .properties;
    const icBlocks = new Map(
      DEFAULT_BLOCK_TEMPLATES.ic.map((t) => [t.block_name, t.description]),
    );

    for (const block of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(props[block]!.description).toBe(icBlocks.get(block));
    }
    expect((tool.schema as { required: string[] }).required).toEqual([
      "name",
      "tag_line",
      "persona",
      "domain",
    ]);
  });
});

// ── Projections + remaining validation gates ─────────────────────────────

describe("projections", () => {
  it("get_task returns the full task projection with nulls for absent fields", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({
            id: "task_9",
            title: "Ship the thing",
            status: "blocked",
            assignee_id: "agent_b",
            blocker_agent_id: "agent_c",
            blocker_reason: "needs the schema decision",
          }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_9" });
    expect(result.isError).toBeFalsy();
    expect((result.content as { task: Record<string, unknown> }).task).toEqual({
      id: "task_9",
      title: "Ship the thing",
      description: null,
      status: "blocked",
      priority: "medium",
      assignee_id: "agent_b",
      creator_id: "agent_a",
      creator_type: "agent",
      parent_task_id: null,
      repo_url: null,
      result_summary: null,
      blocker_agent_id: "agent_c",
      blocker_reason: "needs the schema decision",
      // Timestamps cross the MCP wire as ISO strings, not Date objects.
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
  });

  it("get_agent_profile returns the agent projection, nulling a missing parent", async () => {
    const services = buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_b", name: "Backend", hierarchy_level: "ic" }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_agent_profile", { agent_id: "agent_b" });
    expect((result.content as { agent: Record<string, unknown> }).agent).toEqual({
      id: "agent_b",
      name: "Backend",
      hierarchy_level: "ic",
      parent_agent_id: null,
      owner_id: "person_1",
    });
  });
});

describe("remaining input gates", () => {
  it("create_work_product requires both task_id and title", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);

    for (const input of [{ title: "X" }, { task_id: "task_1" }, {}]) {
      const result = await callTool(tools, "create_work_product", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "task_id and title required" });
    }
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("create_task requires both intent and agent_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    for (const input of [{ intent: "Do it" }, { agent_id: "sub_1" }, {}]) {
      const result = await callTool(tools, "create_task", input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "intent and agent_id required" });
    }
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("create_task rejects a priority outside the domain enum", async () => {
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "Do it",
      agent_id: "sub_1",
      priority: "yesterday",
    });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toContain("priority must be one of");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("create_work_product forwards a metadata object and drops a non-object one", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      type: "report",
      title: "Findings",
      metadata: { rows: 12 },
    });
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { rows: 12 } }),
    );

    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      type: "report",
      title: "Findings",
      metadata: "rows=12",
    });
    expect(services.taskService.createWorkProduct).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: undefined }),
    );
  });

  it("update_work_product forwards a metadata object and drops a non-object one", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "update_work_product", { id: "wp_1", metadata: { rows: 12 } });
    expect(services.taskService.updateWorkProduct).toHaveBeenCalledWith(
      "wp_1",
      expect.objectContaining({ metadata: { rows: 12 } }),
    );

    await callTool(tools, "update_work_product", { id: "wp_1", metadata: 12 });
    expect(services.taskService.updateWorkProduct).toHaveBeenLastCalledWith(
      "wp_1",
      expect.objectContaining({ metadata: undefined }),
    );
  });
});
