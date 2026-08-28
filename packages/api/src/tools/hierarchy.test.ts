/**
 * Hierarchy / work-product tools — unit tests with vitest fakes (no DB).
 *
 * Covers the IC-shared and team-only tools plus the IC vs team set gating
 * in `buildHierarchyTools`. Each tool's handler is a thin closure over
 * (ctx, services); the fakes here exercise auth + delegation.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_TEMPLATES } from "@beevibe/core";
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
    summary: "stuck on scheduling",
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
  const revision = {
    kind: "revision" as const,
    source: "parent_agent" as const,
    from_status: "blocked" as const,
    feedback: "use the mirror registry",
  };

  /** Blocked task assigned to a direct child of `agent_t`. */
  function reviseServices(
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
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "task_1",
            status: "needs_revision",
            assignee_id: "sub_1",
            next_dispatch_context: revision,
          }),
        ),
        ...overrides.taskService,
      },
    });
  }

  function reviseTools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("revises then dispatches the resume session with the stamped context", async () => {
    const services = reviseServices();

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "use the mirror registry",
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the mirror registry",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sub_1",
        type: "task",
        reason: revision,
        intent: expect.stringContaining('<context type="revision"'),
      }),
    );
    expect(result.content).toMatchObject({
      revised: true,
      task_id: "task_1",
      // The task stays at needs_revision until the daemon claims the
      // session — the tool must not optimistically report "revision".
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ id: "task_1", status: "needs_revision", assignee_id: "sub_1" }),
        ),
      },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing task_id", { feedback: "f" }],
    ["a missing feedback", { task_id: "task_1" }],
  ])("rejects %s", async (_label, input) => {
    const services = reviseServices();

    const result = await callTool(reviseTools(services), "revise_task", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and feedback required" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("404s an unknown task", async () => {
    const services = reviseServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_nope",
      feedback: "f",
    });

    expect(result.content).toEqual({ error: "task_not_found", task_id: "task_nope" });
  });

  it("refuses an unassigned task", async () => {
    const services = reviseServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ id: "task_1", status: "blocked" })),
      },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.content).toMatchObject({ error: "task_unassigned" });
  });

  it("refuses when the assignee row is gone", async () => {
    const services = reviseServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.content).toEqual({ error: "assignee_not_found" });
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const services = reviseServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_someone_else" }),
        ),
      },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps InvalidTaskTransitionError to invalid_transition", async () => {
    const services = reviseServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "cannot revise task task_1 from status done",
          );
        }),
      },
    });

    const result = await callTool(reviseTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_transition" });
  });

  it("falls back to the catch-all envelope for any other throw", async () => {
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

    expect(result.content).toEqual({ error: "pool exhausted" });
  });
});

describe("add_to_escalation", () => {
  function tools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("submits the caller's slot, notifies listeners, and reports both-sides state", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({
            initiator_submitted_at: new Date("2026-04-01"),
            counterparty_submitted_at: new Date("2026-04-02"),
          }),
        ),
      } as Partial<EscalationService>,
    });
    const proposals = [{ title: "A", description: "do A" }];

    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["when?", 42],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals,
      // Non-string questions are filtered, not forwarded.
      openQuestions: ["when?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
  });

  it("reports both_sides_submitted false while a slot is still empty", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      } as Partial<EscalationService>,
    });

    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.content).toMatchObject({ both_sides_submitted: false });
  });

  it("omits proposals and open_questions when they aren't arrays", async () => {
    const services = buildServices();

    await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "A or B",
      open_questions: "when?",
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("rejects a missing escalation_id", async () => {
    const services = buildServices();

    const result = await callTool(tools(services), "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("wraps a service throw in the catch-all envelope", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("already submitted");
        }),
      } as Partial<EscalationService>,
    });

    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "already submitted" });
  });
});

describe("create_subordinate_agent", () => {
  const validInput = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, terse, tests first.",
    domain: "packages/api",
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
        create: vi.fn(async (input: unknown) => fakeAgent(input as Partial<Agent>)),
        ...overrides.agentRepo,
      },
      coreMemoryRepo: overrides.coreMemoryRepo,
      agentProvisionEventRepo: overrides.agentProvisionEventRepo,
    });
  }

  function spawnTools(services: ReturnType<typeof buildServices>): AgentTool[] {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("provisions an IC under the caller, inheriting owner and runtime", async () => {
    const services = spawnServices();

    const result = await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Backend specialist",
        owner_id: "person_1",
        parent_agent_id: "agent_t",
        hierarchy_level: "ic",
        runtime_config: expect.objectContaining({
          type: "claude",
          model: "opus",
          // The persona lives in core memory; the system prompt carries
          // the name only.
          system_prompt_addition: "You are Backend specialist.",
        }),
      }),
    );
    expect(result.content).toMatchObject({
      created: { hierarchy_level: "ic", parent_agent_id: "agent_t" },
    });
  });

  it("seeds only the identity blocks the parent actually supplied", async () => {
    const services = spawnServices();

    await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    const seeded = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(seeded.sort()).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds the optional blocks when they carry content", async () => {
    const services = spawnServices();

    await callTool(spawnTools(services), "create_subordinate_agent", {
      ...validInput,
      active_context: "Migrating auth to JWT",
      constraints: "No breaking API changes",
    });

    const seeded = (services.coreMemoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(seeded.sort()).toEqual([
      "active_context",
      "constraints",
      "domain",
      "persona",
      "tag_line",
    ]);
  });

  it("pins the child to the parent's runtime when the parent has one", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", preferred_runtime_id: "rt_1" }),
        ),
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
    });

    await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_runtime_id: "rt_1" }),
    );
  });

  it("writes the audit row that backs the daily cap", async () => {
    const services = spawnServices();

    await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: validInput.persona,
        domain: validInput.domain,
      }),
    );
  });

  it("still returns the new agent when the audit row fails to write", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = spawnServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table locked");
        }),
      },
    });

    const result = await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ created: { hierarchy_level: "ic" } });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    ["name", { ...validInput, name: "  " }],
    ["tag_line", { ...validInput, tag_line: "" }],
    ["persona", { ...validInput, persona: "   " }],
    ["domain", { ...validInput, domain: "" }],
  ])("rejects a blank %s", async (_field, input) => {
    const services = spawnServices();

    const result = await callTool(spawnTools(services), "create_subordinate_agent", input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a tag_line over 100 chars and reports the actual length", async () => {
    const services = spawnServices();

    const result = await callTool(spawnTools(services), "create_subordinate_agent", {
      ...validInput,
      tag_line: "x".repeat(101),
    });

    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["carrying a control character", "Backend\u0001specialist"],
  ])("rejects a name %s", async (_label, name) => {
    const services = spawnServices();

    const result = await callTool(spawnTools(services), "create_subordinate_agent", {
      ...validInput,
      name,
    });

    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("404s when the calling parent row is gone", async () => {
    const services = spawnServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });

    const result = await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(result.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_t",
    });
  });

  it("enforces the per-parent daily spawn cap", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });

    const result = await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("counts spawns over a 24-hour window", async () => {
    const services = spawnServices();

    await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      86_400,
    );
  });

  it("wraps a provisioning throw in the catch-all envelope", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "agent_t" })),
        create: vi.fn(async () => {
          throw new Error("unique violation on name");
        }),
      },
    });

    const result = await callTool(spawnTools(services), "create_subordinate_agent", validInput);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "unique violation on name" });
  });

  it("borrows its field descriptions from the IC block templates", () => {
    const services = spawnServices();
    const tool = findTool(spawnTools(services), "create_subordinate_agent");
    const props = tool.schema.properties as Record<string, { description: string }>;
    const icDescriptions = new Map(
      DEFAULT_BLOCK_TEMPLATES.ic.map((t) => [t.block_name, t.description]),
    );

    for (const field of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(props[field]?.description).toBe(icDescriptions.get(field));
    }
    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
  });
});

// ── Projections + remaining argument guards ──────────────────────────────

describe("projections", () => {
  it("get_task nulls every optional column rather than omitting it", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ id: "task_1" })) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_1" });

    expect((result.content as { task: Record<string, unknown> }).task).toEqual({
      id: "task_1",
      title: "Build X",
      description: null,
      status: "in_progress",
      priority: "medium",
      assignee_id: null,
      creator_id: "agent_a",
      creator_type: "agent",
      parent_task_id: null,
      repo_url: null,
      result_summary: null,
      blocker_agent_id: null,
      blocker_reason: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
  });

  it("find_up nulls a top-level parent's own parent_agent_id", async () => {
    const services = buildServices({
      agentRepo: {
        findParent: vi.fn(async () => fakeAgent({ id: "agent_parent" })),
      },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "find_up");

    expect((result.content as { parent: Record<string, unknown> }).parent).toEqual({
      id: "agent_parent",
      name: "A",
      hierarchy_level: "team",
      parent_agent_id: null,
      owner_id: "person_1",
    });
  });
});

describe("argument guards", () => {
  const icTools = () => {
    const services = buildServices();
    return {
      services,
      tools: buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services),
    };
  };

  it.each([
    ["a missing task_id", { type: "pull_request", title: "t" }],
    ["a missing title", { task_id: "t1", type: "pull_request" }],
  ])("create_work_product rejects %s", async (_label, input) => {
    const { services, tools } = icTools();

    const result = await callTool(tools, "create_work_product", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and title required" });
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("create_work_product forwards a metadata object and drops a non-object one", async () => {
    const { services, tools } = icTools();

    await callTool(tools, "create_work_product", {
      task_id: "t1",
      type: "analysis",
      title: "t",
      metadata: { rows: 3 },
    });
    await callTool(tools, "create_work_product", {
      task_id: "t1",
      type: "analysis",
      title: "t",
      metadata: "rows=3",
    });

    const calls = (services.taskService.createWorkProduct as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ metadata: { rows: 3 } });
    expect(calls[1]?.[0]).toMatchObject({ metadata: undefined });
  });

  it("update_work_product forwards a metadata object and drops a non-object one", async () => {
    const { services, tools } = icTools();

    await callTool(tools, "update_work_product", {
      id: "wp_1",
      metadata: { reviewed: true },
    });
    await callTool(tools, "update_work_product", { id: "wp_1", metadata: 3 });

    const calls = (services.taskService.updateWorkProduct as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ metadata: { reviewed: true } });
    expect(calls[1]?.[1]).toMatchObject({ metadata: undefined });
  });

  it("update_work_product rejects a missing id", async () => {
    const { services, tools } = icTools();

    const result = await callTool(tools, "update_work_product", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "id required" });
    expect(services.taskService.updateWorkProduct).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing intent", { agent_id: "sub_1" }],
    ["a missing agent_id", { intent: "do X" }],
  ])("create_task rejects %s before the authz lookup", async (_label, input) => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "intent and agent_id required" });
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("create_task rejects an unknown priority after authz passes", async () => {
    const services = buildServices({
      agentRepo: {
        findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]),
      },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "do X",
      agent_id: "sub_1",
      priority: "yesterday",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toContain("priority must be one of");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("every tool wraps an unexpected service throw", () => {
  // One table instead of a per-tool test: the envelope is the contract, and
  // a tool that forgets its try/catch would otherwise reject the MCP call
  // instead of handing the agent something it can read.
  const boom = () => {
    throw new Error("pool exhausted");
  };

  function throwingServices(): ReturnType<typeof buildServices> {
    return buildServices({
      agentRepo: {
        findById: vi.fn(boom),
        findParent: vi.fn(boom),
        findSubordinates: vi.fn(boom),
        findPeers: vi.fn(boom),
      },
      taskRepo: { findById: vi.fn(boom), listByAssignee: vi.fn(boom) },
      taskService: {
        updateProgress: vi.fn(boom),
        createWorkProduct: vi.fn(boom),
        listWorkProducts: vi.fn(boom),
        getWorkProduct: vi.fn(boom),
        updateWorkProduct: vi.fn(boom),
      },
      memoryAgent: { searchArchival: vi.fn(boom) } as Partial<MemoryAgent>,
    });
  }

  it.each<[string, Record<string, unknown>]>([
    ["search_context", { query: "auth" }],
    ["update_progress", { task_id: "t1", status: "done", summary: "s" }],
    ["find_up", {}],
    ["get_agent_profile", { agent_id: "agent_x" }],
    ["get_task", { task_id: "t1" }],
    ["create_work_product", { task_id: "t1", type: "pull_request", title: "t" }],
    ["list_work_products", { task_id: "t1" }],
    ["get_work_product", { id: "wp_1" }],
    ["update_work_product", { id: "wp_1", summary: "s" }],
    ["find_subordinates", {}],
    ["find_peers", {}],
    ["create_task", { intent: "do X", agent_id: "sub_1" }],
    // Own-agent status skips the subordinate lookup and hits listByAssignee.
    ["check_work_status", { agent_id: "agent_t" }],
  ])("%s", async (name, input) => {
    const services = throwingServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, name, input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "pool exhausted" });
  });
});
