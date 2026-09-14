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
    // `create_subordinate_agent` reaches the repo through core's
    // `provisionAgent`, which is a thin wrapper over create + initDefaults.
    // Echoing the input back keeps the id/parent assertions honest.
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

  it("get_task projects every field, nulling the absent optionals", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({
            id: "task_1",
            assignee_id: "sub_1",
            blocker_reason: "missing creds",
            blocker_agent_id: "sub_1",
          }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_1" });
    expect((result.content as { task: unknown }).task).toEqual({
      id: "task_1",
      title: "Build X",
      status: "in_progress",
      priority: "medium",
      creator_id: "agent_a",
      creator_type: "agent",
      assignee_id: "sub_1",
      blocker_agent_id: "sub_1",
      blocker_reason: "missing creds",
      // Absent optionals project as null, not undefined — the wire shape
      // is stable so the agent can read a field without guarding.
      description: null,
      parent_task_id: null,
      repo_url: null,
      result_summary: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
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

  it("create_work_product requires task_id and title before checking the type", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    for (const input of [
      { type: "pull_request", title: "x" },
      { task_id: "t1", type: "pull_request" },
    ]) {
      const result = await callTool(tools, "create_work_product", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("task_id and title required");
    }
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
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

  it("requires both intent and agent_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    for (const input of [{}, { intent: "x" }, { agent_id: "sub_1" }]) {
      const result = await callTool(tools, "create_task", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("intent and agent_id required");
    }
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("rejects a priority outside the allowed set", async () => {
    const sub = fakeAgent({ id: "sub_1", hierarchy_level: "ic" });
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [sub]) },
    });
    const tools = buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

    const result = await callTool(tools, "create_task", {
      intent: "x",
      agent_id: "sub_1",
      priority: "yesterday",
    });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toMatch(/^priority must be one of: /);
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
// The canonical post-blocker unblock path: a parent feeds guidance back
// into a subordinate's blocked task, and the revision session is
// dispatched off the `next_dispatch_context` TaskService stamped.

describe("revise_task", () => {
  /** A blocked task assigned to `sub_1`, whose parent is `agent_t`. */
  function blockedTaskServices(
    overrides: Parameters<typeof buildServices>[0] = {},
  ) {
    return buildServices({
      ...overrides,
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "task_b", status: "blocked", assignee_id: "sub_1" }),
        ),
        ...overrides.taskRepo,
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", hierarchy_level: "ic", parent_agent_id: "agent_t" }),
        ),
        ...overrides.agentRepo,
      },
    });
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("revises and dispatches the revision session off next_dispatch_context", async () => {
    const revised = fakeTask({
      id: "task_b",
      title: "Build X",
      description: "the details",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the staging creds",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: "agent_t",
      },
    });
    const services = blockedTaskServices({
      taskService: { reviseTask: vi.fn(async () => revised) },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "use the staging creds",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_b",
      // Post-#186 the task sits at needs_revision until the daemon claims
      // the dispatched session — revise_task does NOT optimistically
      // report "revision".
      status: "needs_revision",
      from_status: "blocked",
    });
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_b",
      "use the staging creds",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );

    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]![0];
    expect(dispatched).toMatchObject({
      task: revised,
      agentId: "sub_1",
      type: "task",
      reason: revised.next_dispatch_context,
    });
    // The intent is built from the stamped context, so the subordinate's
    // resumed turn sees the parent's feedback verbatim.
    expect(dispatched.intent).toContain(
      '<context type="revision" source="parent_agent" from="blocked">',
    );
    expect(dispatched.intent).toContain("use the staging creds");
  });

  it("skips the dispatch when TaskService stamped no revision context", async () => {
    // The default `reviseTask` fake returns a task with no
    // next_dispatch_context — the guard must not dispatch a session with
    // an undefined reason.
    const services = blockedTaskServices();
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "try again",
    });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("requires both task_id and feedback", async () => {
    const services = blockedTaskServices();
    const tools = teamTools(services);

    for (const input of [
      {},
      { task_id: "task_b" },
      { feedback: "do the thing" },
      { task_id: "task_b", feedback: "" },
    ]) {
      const result = await callTool(tools, "revise_task", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe(
        "task_id and feedback required",
      );
    }
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("reports task_not_found for an unknown task", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_gone",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_not_found", task_id: "task_gone" });
  });

  it("refuses an unassigned task — there is no subordinate to unblock", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ id: "task_b", assignee_id: undefined })),
      },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("reports assignee_not_found when the assignee row is gone", async () => {
    const services = blockedTaskServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("assignee_not_found");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not the assignee's direct parent", async () => {
    const services = blockedTaskServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "some_other_team" }),
        ),
      },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "not_parent",
      message: "caller agent_t is not the parent of task assignee sub_1",
    });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps an InvalidTaskTransitionError to a coded invalid_transition", async () => {
    const services = blockedTaskServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "cannot revise task from status 'done'",
          );
        }),
      },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("invalid_transition");
    expect((result.content as { message: string }).message).toMatch(/done/);
  });

  it("falls back to the catch-all envelope for an unexpected throw", async () => {
    const services = blockedTaskServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    });
    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_b",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("connection reset");
  });
});

// ── add_to_escalation (M6.4) ─────────────────────────────────────────────

describe("add_to_escalation", () => {
  function escalation(overrides: Partial<Escalation> = {}): Escalation {
    return {
      id: "esc_1",
      negotiation_id: "neg_1",
      initiator_session_id: "sess_a",
      counterparty_session_id: "sess_b",
      summary: "Ship date disagreement",
      initiator_open_questions: [],
      counterparty_open_questions: [],
      escalated_by_role: "initiator",
      status: "pending",
      created_at: new Date("2026-04-01"),
      updated_at: new Date("2026-04-01"),
      ...overrides,
    };
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_b", hierarchyLevel: "team" }, services);
  }

  it("forwards the caller's slot contribution and notifies listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => escalation()),
      },
    });
    const proposals = [{ title: "Ship behind a flag", description: "why", tradeoffs: "slower" }];

    const result = await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["who owns rollback?"],
    });

    expect(result.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      // The slot is derived server-side from the caller's role — the tool
      // only passes who is calling.
      callerAgentId: "agent_b",
      proposals,
      openQuestions: ["who owns rollback?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated', $1)"),
      ["esc_1"],
    );
  });

  it("reports both_sides_submitted only once both timestamps are set", async () => {
    const at = new Date("2026-04-02");
    const cases: Array<[Partial<Escalation>, boolean]> = [
      [{}, false],
      [{ initiator_submitted_at: at }, false],
      [{ counterparty_submitted_at: at }, false],
      [{ initiator_submitted_at: at, counterparty_submitted_at: at }, true],
    ];

    for (const [stamps, expected] of cases) {
      const services = buildServices({
        escalationService: {
          addContribution: vi.fn(async () => escalation(stamps)),
        },
      });
      const result = await callTool(teamTools(services), "add_to_escalation", {
        escalation_id: "esc_1",
      });
      expect(result.content).toEqual({
        escalation_id: "esc_1",
        status: "pending",
        both_sides_submitted: expected,
      });
    }
  });

  it("requires escalation_id", async () => {
    const services = buildServices();
    const result = await callTool(teamTools(services), "add_to_escalation", {});

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("escalation_id required");
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("drops non-array proposals / open_questions rather than forwarding junk", async () => {
    const services = buildServices({
      escalationService: { addContribution: vi.fn(async () => escalation()) },
    });
    await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "not an array",
      open_questions: { nope: true },
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("filters non-string entries out of open_questions", async () => {
    const services = buildServices({
      escalationService: { addContribution: vi.fn(async () => escalation()) },
    });
    await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real question", 42, null, "another"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real question", "another"] }),
    );
  });

  it("envelopes a service throw — a double submit must not crash the session", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("slot already submitted");
        }),
      },
    });
    const result = await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("slot already submitted");
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent (Phase 9) ───────────────────────────────────

describe("create_subordinate_agent", () => {
  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "A pragmatic backend engineer",
    domain: "Express + Postgres",
  };

  function parentServices(
    overrides: Parameters<typeof buildServices>[0] = {},
    parent: Partial<Agent> = {},
  ) {
    return buildServices({
      ...overrides,
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_t", name: "Team lead", owner_id: "person_1", ...parent }),
        ),
        ...overrides.agentRepo,
      },
    });
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);
  }

  it("provisions an IC under the caller, inheriting owner and runtime", async () => {
    const services = parentServices(
      {},
      {
        runtime_config: { type: "claude", model: "opus" },
        preferred_runtime_id: "rt_laptop",
      },
    );

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0];
    expect(created).toMatchObject({
      name: "Backend specialist",
      owner_id: "person_1",
      parent_agent_id: "agent_t",
      hierarchy_level: "ic",
      // Same human, same machine — the child rides the parent's daemon.
      preferred_runtime_id: "rt_laptop",
    });
    // The parent's runtime is inherited wholesale; only the system prompt
    // is rewritten, and it carries the name ONLY — the persona lives in
    // core memory, so duplicating it here would double the token cost.
    expect(created.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      system_prompt_addition: "You are Backend specialist.",
    });
    expect(created.runtime_config?.system_prompt_addition).not.toContain(VALID.persona);

    expect(result.content).toEqual({
      created: {
        id: created.id,
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_t",
      },
    });
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    const services = parentServices({}, { preferred_runtime_id: undefined });
    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0];
    expect(created).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds only the identity blocks the parent supplied", async () => {
    const services = parentServices();
    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(seeded).toEqual([
      ["tag_line", "Owns the API surface"],
      ["persona", "A pragmatic backend engineer"],
      ["domain", "Express + Postgres"],
    ]);
    // provisionAgent's initDefaults already created the optional blocks
    // empty; the IC fills them in as it works.
    expect(seeded.map(([name]) => name)).not.toContain("active_context");
    expect(seeded.map(([name]) => name)).not.toContain("constraints");
  });

  it("seeds the optional blocks when they carry content", async () => {
    const services = parentServices();
    await callTool(teamTools(services), "create_subordinate_agent", {
      ...VALID,
      active_context: "Migrating auth to SSO",
      constraints: "No schema changes without review",
    });

    const seeded = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map((c) => [c[1], c[2]]);
    expect(seeded).toContainEqual(["active_context", "Migrating auth to SSO"]);
    expect(seeded).toContainEqual(["constraints", "No schema changes without review"]);
  });

  it("writes the provision audit row that backs the daily cap", async () => {
    const services = parentServices();
    await callTool(teamTools(services), "create_subordinate_agent", VALID);

    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0];
    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        child_agent_id: created.id,
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: VALID.persona,
        domain: VALID.domain,
      }),
    );
  });

  it("still reports success when the audit row fails to write", async () => {
    // The agent + its memory are the user-visible artifacts; losing the
    // audit row must not strand a provisioned agent behind an error.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = parentServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table offline");
        }),
      },
    });

    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect((result.content as { created: { id: string } }).created.id).toBeTruthy();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[create_subordinate_agent] audit row failed"),
      "audit table offline",
    );
    consoleError.mockRestore();
  });

  // The handler's leading `ic_cannot_spawn` guard is unreachable through
  // `buildHierarchyTools` — the IC tier never gets the tool in the first
  // place (pinned by the tier-gating suite above). It's defence-in-depth
  // against a future caller that builds the team set directly, so it's
  // left uncovered rather than reached through a contrived seam.

  it("requires name, tag_line, persona and domain", async () => {
    const services = parentServices();
    const tools = teamTools(services);

    for (const missing of ["name", "tag_line", "persona", "domain"] as const) {
      const input: Record<string, unknown> = { ...VALID };
      delete input[missing];
      const result = await callTool(tools, "create_subordinate_agent", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("missing_required_fields");
    }
    // Whitespace-only is the same as absent — the fields are trimmed first.
    const blank = await callTool(tools, "create_subordinate_agent", { ...VALID, domain: "   " });
    expect((blank.content as { error: string }).error).toBe("missing_required_fields");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("caps tag_line at 100 chars so the agent card line stays legible", async () => {
    const services = parentServices();
    const tools = teamTools(services);

    const atLimit = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(100),
    });
    expect(atLimit.isError).toBeFalsy();

    const overLimit = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(101),
    });
    expect(overLimit.isError).toBe(true);
    expect(overLimit.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
  });

  it("rejects an over-long name or one carrying control characters", async () => {
    const services = parentServices();
    const tools = teamTools(services);

    const controlChars = [" ", "", ""].map((c) => `Back${c}end`);
    for (const name of ["x".repeat(81), ...controlChars]) {
      const result = await callTool(tools, "create_subordinate_agent", { ...VALID, name });
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("invalid_name");
    }

    const ok = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      name: "x".repeat(80),
    });
    expect(ok.isError).toBeFalsy();
  });

  it("reports parent_not_found when the caller's own row is missing", async () => {
    const services = buildServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "parent_not_found", agent_id: "agent_t" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("enforces the per-parent daily spawn cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });
    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect((result.content as { message: string }).message).toContain("Team lead");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    // The cap is a rolling 24h window, not a calendar day.
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_t",
      24 * 60 * 60,
    );
  });

  it("allows the spawn one under the cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("envelopes a provisioning throw instead of leaking it to the session", async () => {
    const services = parentServices({
      agentRepo: {
        create: vi.fn(async () => {
          throw new Error("agent name already taken");
        }),
      },
    });
    const result = await callTool(teamTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("agent name already taken");
    expect(services.agentProvisionEventRepo.create).not.toHaveBeenCalled();
  });
});
