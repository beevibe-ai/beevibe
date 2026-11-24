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

function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    negotiation_id: "neg_1",
    initiator_session_id: "ses_init",
    counterparty_session_id: "ses_counter",
    summary: "We're stuck on rollout order.",
    initiator_open_questions: [],
    counterparty_open_questions: [],
    escalated_by_role: "initiator",
    status: "pending",
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
    create: vi.fn(async (input: Record<string, unknown>) =>
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
    updateContent: vi.fn(async () => undefined),
    // provisionAgent seeds the tier's default blocks before the tool
    // overwrites the identity-bearing ones.
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

describe("revise_task", () => {
  /** A blocked task assigned to `sub_1`, whose parent is `agent_t`. */
  function revisableServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ) {
    return buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", hierarchy_level: "ic", parent_agent_id: "agent_t" }),
        ),
      },
      ...overrides,
    });
  }

  const parentCtx = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  it("revises, stamps the reviser, and dispatches the revision session", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "task_b",
            status: "needs_revision",
            assignee_id: "sub_1",
            next_dispatch_context: {
              kind: "revision",
              feedback: "use the staging secret",
              from_status: "blocked",
            },
          } as Partial<Task>),
        ),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "use the staging secret",
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_b",
      "use the staging secret",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
    // Dispatched to the assignee, not the caller.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "sub_1", type: "task" }),
    );
    // Post-#186 the status reported is whatever the service left behind —
    // needs_revision until the daemon claims it — plus where it came from.
    expect(result.content).toMatchObject({
      revised: true,
      task_id: "task_b",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("reuses the stamped next_dispatch_context verbatim as the resume reason", async () => {
    const stamped = {
      kind: "revision" as const,
      feedback: "use the staging secret",
      from_status: "blocked" as const,
    };
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "task_b",
            status: "needs_revision",
            assignee_id: "sub_1",
            next_dispatch_context: stamped,
          } as Partial<Task>),
        ),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    await callTool(tools, "revise_task", { task_id: "task_b", feedback: "f" });

    const arg = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]![0];
    expect(arg.reason).toEqual(stamped);
    // The intent is built from the task + reason, so it must be non-empty
    // or the resumed session has nothing to act on.
    expect(arg.intent).toBeTruthy();
  });

  it("skips the dispatch when the service left no revision context", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "needs_revision", assignee_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing task_id", { feedback: "f" }],
    ["missing feedback", { task_id: "task_b" }],
  ])("rejects %s without a repo read", async (_label, input) => {
    const services = revisableServices();
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and feedback required" });
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("reports task_not_found for an unknown task", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "nope",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_not_found", task_id: "nope" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("reports task_unassigned when there is nobody to revise", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ id: "task_b", status: "blocked" })),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_unassigned" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("reports assignee_not_found when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "ghost" }),
        ),
      },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "assignee_not_found" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "someone_else" }),
        ),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a grandparent — authz is the direct parent only", async () => {
    // sub_1's parent is the mid-level agent, not the org-tier caller.
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_mid" }),
        ),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_org", hierarchyLevel: "org" },
      services,
    );

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
  });

  it("maps an invalid transition to its own code, not the catch-all", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "task task_b is done; revise requires blocked or review",
          );
        }),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_transition" });
    expect((result.content as { message: string }).message).toBeTruthy();
  });

  it("envelopes an unexpected throw as the catch-all", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("deadlock detected");
        }),
      },
    });
    const tools = buildHierarchyTools(parentCtx, services);

    const result = await callTool(tools, "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "deadlock detected" });
  });
});

// ── add_to_escalation (M6.4) ─────────────────────────────────────────────

describe("add_to_escalation", () => {
  const ctx = { agentId: "agent_peer", hierarchyLevel: "team" as HierarchyLevel };

  it("submits the caller's slot and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "B", description: "do B", tradeoffs: "slower" }],
      open_questions: ["what is the SLA?"],
    });

    expect(result.isError).toBeFalsy();
    // The slot is derived from the caller's role on the negotiation —
    // the agent cannot name a side, and there is no summary arg.
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_peer",
      proposals: [{ title: "B", description: "do B", tradeoffs: "slower" }],
      openQuestions: ["what is the SLA?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
  });

  it("reports both_sides_submitted only once each slot has a timestamp", async () => {
    const onlyOne = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ initiator_submitted_at: new Date("2026-04-01") }),
        ),
      },
    });
    const first = await callTool(
      buildHierarchyTools(ctx, onlyOne),
      "add_to_escalation",
      { escalation_id: "esc_1" },
    );
    expect(first.content).toMatchObject({ both_sides_submitted: false });

    const both = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({
            initiator_submitted_at: new Date("2026-04-01"),
            counterparty_submitted_at: new Date("2026-04-02"),
          }),
        ),
      },
    });
    const second = await callTool(
      buildHierarchyTools(ctx, both),
      "add_to_escalation",
      { escalation_id: "esc_1" },
    );
    // Both slots filled, but the row stays `pending` — only a human
    // resolving it via POST /escalation/:id/resolve moves the status on.
    expect(second.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
  });

  it("omits non-array proposals and filters non-strings from open_questions", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "one idea",
      open_questions: ["keep", 7, undefined, "this too"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        proposals: undefined,
        openQuestions: ["keep", "this too"],
      }),
    );
  });

  it("requires an escalation_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("envelopes a double-submit rejection from the service", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("slot already submitted");
        }),
      },
    });
    const tools = buildHierarchyTools(ctx, services);

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "slot already submitted" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent (Phase 9) ───────────────────────────────────

describe("create_subordinate_agent", () => {
  const teamCtx = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  /** The minimum briefing the tool accepts. */
  const briefing = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, writes migrations defensively.",
    domain: "packages/api, packages/core",
  };

  function parentServices(overrides: Parameters<typeof buildServices>[0] = {}) {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_t",
            name: "Team lead",
            owner_id: "person_9",
            hierarchy_level: "team",
            runtime_config: { type: "claude", model: "opus" },
            preferred_runtime_id: "rt_1",
          } as Partial<Agent>),
        ),
        create: vi.fn(async (input: Record<string, unknown>) =>
          fakeAgent(input as Partial<Agent>),
        ),
      },
      ...overrides,
    });
  }

  it("provisions an IC under the caller, inheriting owner + runtime", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    expect(result.isError).toBeFalsy();
    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(created).toMatchObject({
      name: "Backend specialist",
      owner_id: "person_9",
      parent_agent_id: "agent_t",
      hierarchy_level: "ic",
      // Same human, same machine — the child lands on the parent's daemon.
      preferred_runtime_id: "rt_1",
    });
    // Parent's runtime config carries over; only the prompt line is replaced,
    // and it carries the name alone (persona lives in core memory).
    expect(created.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      system_prompt_addition: "You are Backend specialist.",
    });
    expect(String(created.runtime_config)).not.toContain("Pragmatic");

    expect(result.content).toEqual({
      created: {
        id: expect.any(String),
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_t",
      },
    });
  });

  it("seeds the required identity blocks and skips the optional ones when blank", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    await callTool(tools, "create_subordinate_agent", briefing);

    const written = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(written).toEqual([
      ["tag_line", "Owns the API surface"],
      ["persona", "Pragmatic, writes migrations defensively."],
      ["domain", "packages/api, packages/core"],
    ]);
    // provisionAgent already created them empty; nothing overwrites
    // active_context / constraints with "" when the parent omitted them.
    expect(written.map(([b]) => b)).not.toContain("active_context");
    expect(written.map(([b]) => b)).not.toContain("constraints");
  });

  it("seeds the optional blocks when the parent supplies them", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    await callTool(tools, "create_subordinate_agent", {
      ...briefing,
      active_context: "Migrating auth to SSO.",
      constraints: "Never touch migrations/ without review.",
    });

    const blocks = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => c[1]);
    expect(blocks).toContain("active_context");
    expect(blocks).toContain("constraints");
  });

  it("writes one audit row carrying the briefing", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    await callTool(tools, "create_subordinate_agent", briefing);

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledTimes(1);
    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        owner_person_id: "person_9",
        child_name: "Backend specialist",
        persona: "Pragmatic, writes migrations defensively.",
        domain: "packages/api, packages/core",
      }),
    );
  });

  it("still reports success when the audit row fails to write", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = parentServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table is read-only");
        }),
      },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    // The agent + its memory are the user-visible artifacts; losing the
    // audit row must not strand a provisioned agent behind an error.
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      created: expect.objectContaining({ hierarchy_level: "ic" }),
    });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("is absent from the IC set — ICs cannot spawn subordinates", async () => {
    const services = parentServices();
    const icTools = buildHierarchyTools(
      { agentId: "agent_ic", hierarchyLevel: "ic" },
      services,
    );

    // Tier gating is the real enforcement: an IC is never handed the tool,
    // so the `ic_cannot_spawn` branch inside the handler is defence in
    // depth and unreachable through `buildHierarchyTools` — ctx drives both
    // the set it builds and the guard it would hit.
    expect(icTools.map((t) => t.name)).not.toContain("create_subordinate_agent");
  });

  it.each([
    ["no name", { ...briefing, name: "" }],
    ["no tag_line", { ...briefing, tag_line: "" }],
    ["no persona", { ...briefing, persona: "" }],
    ["no domain", { ...briefing, domain: "" }],
    ["whitespace-only persona", { ...briefing, persona: "   " }],
  ])("rejects a briefing with %s and provisions nothing", async (_label, input) => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a tag_line over 100 chars, reporting the actual length", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...briefing,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a tag_line of exactly 100 chars", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...briefing,
      tag_line: "x".repeat(100),
    });

    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["a NUL byte", "Back\u0000end"],
    ["a newline", "Backend\nspecialist"],
    ["an escape char", "Backend\u001bspecialist"],
  ])("rejects a name with %s", async (_label, name) => {
    const services = parentServices();
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", {
      ...briefing,
      name,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("reports parent_not_found when the caller's own row is missing", async () => {
    const services = buildServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_t",
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("enforces the per-parent 24h spawn cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      86400,
    );
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("allows the spawn that lands exactly on the cap boundary", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", owner_id: "person_9" }),
        ),
        create: vi.fn(async (input: Record<string, unknown>) =>
          fakeAgent(input as Partial<Agent>),
        ),
      },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    await callTool(tools, "create_subordinate_agent", briefing);

    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(created).not.toHaveProperty("preferred_runtime_id");
  });

  it("envelopes a failure from the provisioning insert", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", owner_id: "person_9" }),
        ),
        create: vi.fn(async () => {
          throw new Error("duplicate key value violates unique constraint");
        }),
      },
    });
    const tools = buildHierarchyTools(teamCtx, services);

    const result = await callTool(tools, "create_subordinate_agent", briefing);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "duplicate key value violates unique constraint",
    });
    expect(services.agentProvisionEventRepo.create).not.toHaveBeenCalled();
  });

  it("documents each field from the IC block templates, so guidance stays in lockstep", async () => {
    const services = parentServices();
    const tool = findTool(
      buildHierarchyTools(teamCtx, services),
      "create_subordinate_agent",
    );

    const props = (tool.schema as { properties: Record<string, { description: string }> })
      .properties;
    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
    for (const block of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(props[block]?.description, `${block} description`).toBeTruthy();
    }
  });
});

// ── Projection + remaining validation branches ───────────────────────────

describe("projection shape", () => {
  it("get_task projects a whitelist, normalizing absent description to null", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_1", status: "blocked", assignee_id: "sub_1" }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_1" });

    const task = (result.content as { task: Record<string, unknown> }).task;
    expect(task).toMatchObject({
      id: "task_1",
      title: "Build X",
      status: "blocked",
      // Absent in the row; the wire contract is an explicit null.
      description: null,
    });
    // Nothing internal leaks — notably not next_dispatch_context.
    expect(task).not.toHaveProperty("next_dispatch_context");
  });

  it("get_agent_profile projects a whitelist without the agent's api key", async () => {
    const services = buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_a", name: "A" } as Partial<Agent>),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_agent_profile", { agent_id: "agent_a" });

    const agent = (result.content as { agent: Record<string, unknown> }).agent;
    expect(agent).toMatchObject({ id: "agent_a", name: "A" });
    expect(agent).not.toHaveProperty("api_key");
    expect(agent).not.toHaveProperty("runtime_config");
  });
});

describe("input validation on the write tools", () => {
  it("create_work_product requires task_id and title", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "create_work_product", {
      type: "pull_request",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and title required" });
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("create_task requires intent and agent_id before the authz read", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", { intent: "do the thing" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "intent and agent_id required" });
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("create_task rejects a priority outside the enum", async () => {
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "do the thing",
      agent_id: "sub_1",
      priority: "yesterday",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toMatch(
      /^priority must be one of: /,
    );
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

// ── Error envelopes ──────────────────────────────────────────────────────

describe("every tool envelopes an unexpected throw instead of rejecting", () => {
  // An MCP handler that throws crashes the agent's tool call with no
  // structured content, so each tool wraps its body. One repo/service per
  // tool is made to blow up and the envelope is checked.
  const cases: Array<{
    tool: string;
    input: Record<string, unknown>;
    services: () => ReturnType<typeof buildServices>;
  }> = [
    {
      tool: "find_up",
      input: {},
      services: () =>
        buildServices({
          agentRepo: {
            findParent: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "get_agent_profile",
      input: { agent_id: "agent_a" },
      services: () =>
        buildServices({
          agentRepo: {
            findById: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "get_task",
      input: { task_id: "task_1" },
      services: () =>
        buildServices({
          taskRepo: {
            findById: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "update_progress",
      input: { task_id: "task_1", status: "done" },
      services: () =>
        buildServices({
          taskService: {
            updateProgress: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "search_context",
      input: { query: "auth" },
      services: () =>
        buildServices({
          memoryAgent: {
            searchArchival: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "create_work_product",
      input: { task_id: "task_1", title: "T", type: "pull_request" },
      services: () =>
        buildServices({
          taskService: {
            createWorkProduct: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "list_work_products",
      input: { task_id: "task_1" },
      services: () =>
        buildServices({
          taskService: {
            listWorkProducts: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "get_work_product",
      input: { id: "wp_1" },
      services: () =>
        buildServices({
          taskService: {
            getWorkProduct: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "update_work_product",
      input: { id: "wp_1", summary: "T2" },
      services: () =>
        buildServices({
          taskService: {
            updateWorkProduct: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "find_subordinates",
      input: {},
      services: () =>
        buildServices({
          agentRepo: {
            findSubordinates: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "find_peers",
      input: {},
      services: () =>
        buildServices({
          agentRepo: {
            findPeers: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "create_task",
      input: { intent: "do it", agent_id: "sub_1" },
      services: () =>
        buildServices({
          agentRepo: {
            findSubordinates: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
    {
      tool: "check_work_status",
      input: { agent_id: "agent_t" },
      services: () =>
        buildServices({
          taskRepo: {
            listByAssignee: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        }),
    },
  ];

  it.each(cases.map((c) => [c.tool, c] as const))(
    "%s returns { error } rather than rejecting",
    async (_name, c) => {
      const services = c.services();
      const tools = buildHierarchyTools(
        { agentId: "agent_t", hierarchyLevel: "team" },
        services,
      );

      const result = await callTool(tools, c.tool, c.input);

      expect(result.isError).toBe(true);
      expect(result.content).toEqual({ error: "boom" });
    },
  );

  it("covers every tool in the team set", () => {
    const names = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      buildServices(),
    ).map((t) => t.name);
    const exercised = new Set([
      ...cases.map((c) => c.tool),
      // These three have their own describe blocks above, with the
      // catch-all asserted there alongside their coded failures.
      "revise_task",
      "add_to_escalation",
      "create_subordinate_agent",
    ]);

    expect(names.filter((n) => !exercised.has(n))).toEqual([]);
  });
});

describe("optional work-product fields", () => {
  it("passes a metadata object through on create and drops a non-object", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      title: "T",
      type: "pull_request",
      url: "https://example.test/pr/1",
      metadata: { pr_number: 7 },
    });
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test/pr/1",
        metadata: { pr_number: 7 },
      }),
    );

    const second = buildServices();
    await callTool(
      buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, second),
      "create_work_product",
      { task_id: "task_1", title: "T", type: "pull_request", metadata: "nope" },
    );
    expect(second.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: undefined }),
    );
  });

  it("passes a metadata object through on update", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "update_work_product", {
      id: "wp_1",
      metadata: { merged: true },
    });

    expect(services.taskService.updateWorkProduct).toHaveBeenCalledWith(
      "wp_1",
      expect.objectContaining({ metadata: { merged: true } }),
    );
  });
});
