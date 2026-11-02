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
  pool?: Partial<Pool>;
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    // provisionAgent (called by create_subordinate_agent) inserts through
    // this; echo the input back as the created row.
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
    searchArchival: vi.fn(async () => []),
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
    ...overrides.pool,
  } as unknown as Pool;

  const coreMemoryRepo = {
    findByAgent: vi.fn(async () => []),
    updateContent: vi.fn(async () => undefined),
    // provisionAgent calls this right after the insert.
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

/**
 * The parent's post-blocker unblock path. Authz is the interesting part:
 * the caller must be the *direct* parent of the task's assignee, which
 * means two lookups (task, then assignee) and four distinct refusals
 * before any state changes.
 */
describe("revise_task", () => {
  const CTX = { agentId: "agent_parent", hierarchyLevel: "team" as HierarchyLevel };

  /** Assignee whose parent is the caller — the authorized shape. */
  function ownSubordinate() {
    return fakeAgent({
      id: "agent_sub",
      hierarchy_level: "ic",
      parent_agent_id: "agent_parent",
    });
  }

  function servicesFor(
    over: Parameters<typeof buildServices>[0] = {},
    task: Task = fakeTask({ id: "t_blocked", status: "blocked", assignee_id: "agent_sub" }),
    assignee: Agent | undefined = ownSubordinate(),
  ) {
    return buildServices({
      taskRepo: { findById: vi.fn(async () => task), ...over.taskRepo },
      agentRepo: { findById: vi.fn(async () => assignee), ...over.agentRepo },
      ...over,
    });
  }

  it("requires both task_id and feedback", async () => {
    const services = servicesFor();
    const tools = buildHierarchyTools(CTX, services);

    for (const input of [
      {},
      { task_id: "t_blocked" },
      { feedback: "try again" },
      { task_id: "", feedback: "try again" },
    ]) {
      const res = await callTool(tools, "revise_task", input);
      expect(res.isError).toBe(true);
    }
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("reports task_not_found for an unknown task", async () => {
    const services = servicesFor({ taskRepo: { findById: vi.fn(async () => undefined) } });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_ghost",
      feedback: "go",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "task_not_found", task_id: "t_ghost" });
  });

  it("refuses a task with no assignee", async () => {
    const services = servicesFor(
      {},
      fakeTask({ id: "t_free", status: "blocked", assignee_id: undefined }),
    );
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", { task_id: "t_free", feedback: "go" });
    expect(res.content).toMatchObject({ error: "task_unassigned" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses when the assignee row is missing", async () => {
    const services = servicesFor({}, undefined as unknown as Task, undefined);
    // Re-point the task lookup; only the assignee should be absent.
    const tools = buildHierarchyTools(
      CTX,
      buildServices({
        taskRepo: {
          findById: vi.fn(async () =>
            fakeTask({ id: "t_blocked", status: "blocked", assignee_id: "agent_gone" }),
          ),
        },
        agentRepo: { findById: vi.fn(async () => undefined) },
      }),
    );
    void services;
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "go",
    });
    expect(res.content).toMatchObject({ error: "assignee_not_found" });
  });

  // The authz boundary: a team agent may not revise another team's work
  // just because it can see the task.
  it("refuses when the caller is not the assignee's direct parent", async () => {
    const services = servicesFor(
      {},
      fakeTask({ id: "t_blocked", status: "blocked", assignee_id: "agent_sub" }),
      fakeAgent({ id: "agent_sub", parent_agent_id: "agent_someone_else" }),
    );
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "go",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "not_parent" });
    expect(String((res.content as { message: string }).message)).toContain("agent_parent");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a grandchild (parent_agent_id must match exactly)", async () => {
    const services = servicesFor(
      {},
      fakeTask({ id: "t_blocked", status: "blocked", assignee_id: "agent_grandchild" }),
      fakeAgent({ id: "agent_grandchild", parent_agent_id: "agent_sub" }),
    );
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "go",
    });
    expect(res.content).toMatchObject({ error: "not_parent" });
  });

  it("revises and reports the from_status it moved out of", async () => {
    const services = servicesFor();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "use the v2 endpoint",
    });

    expect(res.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "t_blocked",
      "use the v2 endpoint",
      { source: "parent_agent", reviserAgentId: "agent_parent" },
    );
    expect(res.content).toMatchObject({
      revised: true,
      // Post-#186 the task waits at needs_revision for the daemon claim
      // rather than flipping to 'revision' inline.
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("does not dispatch when reviseTask stamped no revision context", async () => {
    // Default fake returns a task with no next_dispatch_context.
    const services = servicesFor();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "revise_task", { task_id: "t_blocked", feedback: "go" });
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("dispatches the resume session using the stamped revision context", async () => {
    const reason = {
      kind: "revision" as const,
      feedback: "use the v2 endpoint",
      from_status: "blocked" as const,
      source: "parent_agent" as const,
    };
    const services = servicesFor({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            id: "t_blocked",
            status: "needs_revision",
            assignee_id: "agent_sub",
            next_dispatch_context: reason,
          }),
        ),
      },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "use the v2 endpoint",
    });

    expect(res.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const arg = (services.dispatchService.dispatchTask as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    }).mock.calls[0]![0];
    // Dispatched at the *subordinate*, not the caller — the IC is the one
    // resuming with the feedback injected.
    expect(arg).toMatchObject({
      agentId: "agent_sub",
      type: "task",
      reason,
    });
    expect(typeof arg.intent).toBe("string");
  });

  it("maps InvalidTaskTransitionError to invalid_transition", async () => {
    const services = servicesFor({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("cannot revise a task in status done");
        }),
      },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "go",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_transition" });
  });

  it("envelopes any other throw", async () => {
    const services = servicesFor({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("pg down");
        }),
      },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "revise_task", {
      task_id: "t_blocked",
      feedback: "go",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "pg down" });
  });
});

// ── add_to_escalation (M6.4) ─────────────────────────────────────────────

/**
 * The responder's half of a peer escalation. The tool deliberately takes
 * no `summary` — the initiator set that and it's immutable — so what's
 * left here is argument coercion plus the pg_notify side effect.
 */
describe("add_to_escalation", () => {
  const CTX = { agentId: "agent_b", hierarchyLevel: "team" as HierarchyLevel };

  it("requires an escalation_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "add_to_escalation", {});
    expect(res.isError).toBe(true);
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("rejects an empty-string escalation_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "add_to_escalation", { escalation_id: "" });
    expect(res.isError).toBe(true);
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("takes no summary argument — the initiator's is immutable", () => {
    const tools = buildHierarchyTools(CTX, buildServices());
    const tool = findTool(tools, "add_to_escalation");
    const props = tool.schema.properties as Record<string, unknown>;
    expect(props.summary).toBeUndefined();
    expect(Object.keys(props).sort()).toEqual([
      "escalation_id",
      "open_questions",
      "proposals",
    ]);
  });

  it("forwards proposals and open_questions with the caller's agent id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    const proposals = [{ title: "Cache it", description: "Add a read-through cache" }];
    const res = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["What is the SLA?"],
    });

    expect(res.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_b",
      proposals,
      openQuestions: ["What is the SLA?"],
    });
  });

  it("passes undefined for non-array proposals and questions", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "just one",
      open_questions: "why?",
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("filters non-string open_questions", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real", 42, null, "also real"],
    });
    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real", "also real"] }),
    );
  });

  it("notifies escalation_updated so a watching UI can refresh", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "add_to_escalation", { escalation_id: "esc_7" });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated', $1)"),
      ["esc_7"],
    );
  });

  it("reports both_sides_submitted false while one slot is empty", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => ({
          id: "esc_1",
          status: "pending",
          initiator_submitted_at: new Date("2026-04-01"),
        })),
      } as unknown as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(res.content).toMatchObject({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });
  });

  it("reports both_sides_submitted once each side has a timestamp", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => ({
          id: "esc_1",
          status: "ready_for_human",
          initiator_submitted_at: new Date("2026-04-01"),
          counterparty_submitted_at: new Date("2026-04-02"),
        })),
      } as unknown as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(res.content).toMatchObject({
      status: "ready_for_human",
      both_sides_submitted: true,
    });
  });

  it("envelopes a service throw", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("already submitted");
        }),
      } as unknown as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "already submitted" });
  });

  it("does not notify when the contribution failed", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("nope");
        }),
      } as unknown as Partial<EscalationService>,
    });
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "add_to_escalation", { escalation_id: "esc_1" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent (Phase 9) ───────────────────────────────────

/**
 * Agent provisioning from inside a session — the onboarding path a team
 * agent uses to assemble its specialists. The validation gates run in a
 * fixed order and each one is a distinct agent-visible code, so they are
 * pinned individually. The daily cap and the audit-row-failure tolerance
 * are the two behaviors most likely to regress silently.
 */
describe("create_subordinate_agent", () => {
  const CTX = { agentId: "agent_parent", hierarchyLevel: "team" as HierarchyLevel };

  const GOOD = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic backend engineer",
    domain: "Express routes, Postgres schema",
  };

  function parentServices(over: Parameters<typeof buildServices>[0] = {}) {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_parent",
            name: "Lead",
            owner_id: "person_1",
            hierarchy_level: "team",
            runtime_config: { type: "claude", model: "opus" },
          }),
        ),
        ...over.agentRepo,
      },
      ...over,
    });
  }

  // Gating is structural: the tool is only built into the team/org set,
  // so an IC caller never receives it. The handler's own
  // `hierarchyLevel === "ic"` re-check is belt-and-braces behind that.
  it("is absent from the IC tool set", () => {
    const services = parentServices();
    const icTools = buildHierarchyTools(
      { agentId: "agent_ic", hierarchyLevel: "ic" },
      services,
    );
    expect(icTools.some((t) => t.name === "create_subordinate_agent")).toBe(false);
    expect(buildHierarchyTools(CTX, services).some(
      (t) => t.name === "create_subordinate_agent",
    )).toBe(true);
  });

  it("requires name, tag_line, persona and domain", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    for (const key of ["name", "tag_line", "persona", "domain"] as const) {
      const res = await callTool(tools, "create_subordinate_agent", {
        ...GOOD,
        [key]: "   ",
      });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "missing_required_fields" });
    }
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a tag_line over 100 chars and reports the actual length", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", {
      ...GOOD,
      tag_line: "x".repeat(101),
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "tag_line_too_long", actual: 101 });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a tag_line at exactly 100 chars", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", {
      ...GOOD,
      tag_line: "x".repeat(100),
    });
    expect(res.isError).toBeFalsy();
  });

  it("rejects a name over 80 chars", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", {
      ...GOOD,
      name: "n".repeat(81),
    });
    expect(res.content).toMatchObject({ error: "invalid_name" });
  });

  it("rejects control characters in the name", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    for (const name of ["Bad\u0000name", "Bad\u001fname", "Bad\u007fname"]) {
      const res = await callTool(tools, "create_subordinate_agent", { ...GOOD, name });
      expect(res.content).toMatchObject({ error: "invalid_name" });
    }
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("reports parent_not_found when the caller does not resolve", async () => {
    const services = parentServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_parent",
    });
  });

  it("refuses once the parent hits the 24h spawn cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    // Cap window is 24h expressed in seconds.
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_parent",
      86400,
    );
  });

  it("still allows a spawn one under the cap", async () => {
    const services = parentServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);
    expect(res.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalled();
  });

  it("creates the child as an IC owned by the parent's owner", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);

    expect(res.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Backend specialist",
        owner_id: "person_1",
        parent_agent_id: "agent_parent",
        hierarchy_level: "ic",
      }),
    );
    expect(res.content).toMatchObject({
      created: expect.objectContaining({
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_parent",
      }),
    });
  });

  it("inherits the parent runtime config but overrides system_prompt_addition", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", GOOD);
    const arg = (services.agentRepo.create as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    }).mock.calls[0]![0];
    expect(arg.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      // The persona stays in core memory; only the name goes in the prompt.
      system_prompt_addition: "You are Backend specialist.",
    });
  });

  it("pins the child to the parent's runtime when the parent has one", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "agent_parent",
            owner_id: "person_1",
            preferred_runtime_id: "rt_laptop",
          }),
        ),
      },
    });
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", GOOD);
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ preferred_runtime_id: "rt_laptop" }),
    );
  });

  it("omits preferred_runtime_id when the parent has none", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", GOOD);
    const arg = (services.agentRepo.create as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    }).mock.calls[0]![0];
    expect("preferred_runtime_id" in arg).toBe(false);
  });

  it("seeds the three required identity blocks and skips the empty optional ones", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", GOOD);

    const written = (services.coreMemoryRepo.updateContent as unknown as {
      mock: { calls: Array<[string, string, string]> };
    }).mock.calls.map(([, block, content]) => [block, content]);
    expect(written).toEqual([
      ["tag_line", "Owns the API surface"],
      ["persona", "Pragmatic backend engineer"],
      ["domain", "Express routes, Postgres schema"],
    ]);
  });

  it("seeds active_context and constraints when supplied", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", {
      ...GOOD,
      active_context: "Migrating to v2",
      constraints: "No breaking changes",
    });

    const written = (services.coreMemoryRepo.updateContent as unknown as {
      mock: { calls: Array<[string, string, string]> };
    }).mock.calls.map(([, block]) => block);
    expect(written).toEqual([
      "tag_line",
      "persona",
      "domain",
      "active_context",
      "constraints",
    ]);
  });

  it("trims whitespace off every seeded field", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    await callTool(tools, "create_subordinate_agent", {
      name: "  Backend specialist  ",
      tag_line: "  Owns the API surface  ",
      persona: "  Pragmatic  ",
      domain: "  Routes  ",
    });
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Backend specialist" }),
    );
    const written = (services.coreMemoryRepo.updateContent as unknown as {
      mock: { calls: Array<[string, string, string]> };
    }).mock.calls.map(([, , content]) => content);
    expect(written).toEqual(["Owns the API surface", "Pragmatic", "Routes"]);
  });

  it("writes the audit row that backs the cap query", async () => {
    const services = parentServices();
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);
    const childId = (res.content as { created: { id: string } }).created.id;

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_parent",
        child_agent_id: childId,
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: "Pragmatic backend engineer",
        domain: "Express routes, Postgres schema",
      }),
    );
  });

  // The agent + its memory are the user-visible artifacts; losing the
  // audit row must not cost the user a provisioned specialist.
  it("still succeeds when the audit row fails to write", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const services = parentServices({
        agentProvisionEventRepo: {
          create: vi.fn(async () => {
            throw new Error("audit table gone");
          }),
        },
      });
      const tools = buildHierarchyTools(CTX, services);
      const res = await callTool(tools, "create_subordinate_agent", GOOD);
      expect(res.isError).toBeFalsy();
      expect(res.content).toMatchObject({ created: expect.any(Object) });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("envelopes a provisioning failure", async () => {
    const services = parentServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_parent", owner_id: "person_1" }),
        ),
        create: vi.fn(async () => {
          throw new Error("duplicate agent name");
        }),
      },
    });
    const tools = buildHierarchyTools(CTX, services);
    const res = await callTool(tools, "create_subordinate_agent", GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "duplicate agent name" });
  });

  it("borrows its per-field descriptions from the IC block templates", () => {
    const tools = buildHierarchyTools(CTX, parentServices());
    const tool = findTool(tools, "create_subordinate_agent");
    const props = tool.schema.properties as Record<string, { description: string }>;
    // Each field maps onto the same-named core memory block, so the
    // guidance the parent reads is the block's own description.
    for (const field of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      expect(props[field]?.description).toBeTruthy();
    }
    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
  });
});

// ── Remaining validation gates ───────────────────────────────────────────

/**
 * The cheap refusals every tool does before it touches a service. They
 * share a shape (`{ error }` + `isError`) but not a code, and an argument
 * silently coerced to "" instead of refused would reach the repo as a
 * lookup for the empty id.
 */
describe("argument gates", () => {
  const IC = { agentId: "agent_ic", hierarchyLevel: "ic" as HierarchyLevel };
  const TEAM = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  it("search_context refuses a blank query", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    for (const input of [{}, { query: "" }, { query: "   " }]) {
      const res = await callTool(tools, "search_context", input);
      expect(res.isError).toBe(true);
    }
    expect(services.memoryAgent.searchArchival).not.toHaveBeenCalled();
  });

  it("get_task refuses a blank task_id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    const res = await callTool(tools, "get_task", {});
    expect(res.isError).toBe(true);
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("get_task projects a found task and returns null for a miss", async () => {
    const found = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "t1", title: "Build X", description: undefined }),
        ),
      },
    });
    const hit = await callTool(buildHierarchyTools(IC, found), "get_task", {
      task_id: "t1",
    });
    expect(hit.isError).toBeFalsy();
    expect((hit.content as { task: Record<string, unknown> }).task).toMatchObject({
      id: "t1",
      title: "Build X",
      // Absent description normalizes to null rather than disappearing.
      description: null,
      status: "in_progress",
    });

    const miss = await callTool(buildHierarchyTools(IC, buildServices()), "get_task", {
      task_id: "t_ghost",
    });
    expect(miss.isError).toBeFalsy();
    expect((miss.content as { task: unknown }).task).toBeNull();
  });

  it("create_work_product refuses a missing task_id or title", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    for (const input of [
      {},
      { task_id: "t1" },
      { title: "PR" },
      { task_id: "t1", title: "" },
    ]) {
      const res = await callTool(tools, "create_work_product", input);
      expect(res.isError).toBe(true);
    }
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("create_work_product forwards the optional provider/external_id/metadata trio", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    const res = await callTool(tools, "create_work_product", {
      task_id: "t1",
      title: "Add error handling",
      type: "pull_request",
      provider: "github",
      external_id: "42",
      metadata: { branch: "main" },
    });
    expect(res.isError).toBeFalsy();
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        external_id: "42",
        metadata: { branch: "main" },
      }),
    );
  });

  it("create_work_product drops wrongly-typed optional fields", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    await callTool(tools, "create_work_product", {
      task_id: "t1",
      title: "T",
      type: "pull_request",
      provider: 1,
      external_id: 2,
      metadata: "nope",
    });
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: undefined,
        external_id: undefined,
        metadata: undefined,
      }),
    );
  });

  it("update_work_product refuses a blank id", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    const res = await callTool(tools, "update_work_product", {});
    expect(res.isError).toBe(true);
    expect(services.taskService.updateWorkProduct).not.toHaveBeenCalled();
  });

  it("update_work_product forwards only the mutable fields it was given", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(IC, services);
    const res = await callTool(tools, "update_work_product", {
      id: "wp_1",
      summary: "now with tests",
      external_id: "99",
      metadata: { runs: 2 },
      // Identity fields are immutable; passing them changes nothing.
      type: "doc",
      task_id: "t_other",
    });
    expect(res.isError).toBeFalsy();
    const patch = (services.taskService.updateWorkProduct as unknown as {
      mock: { calls: Array<[string, Record<string, unknown>]> };
    }).mock.calls[0]!;
    expect(patch[0]).toBe("wp_1");
    expect(patch[1]).toMatchObject({
      summary: "now with tests",
      external_id: "99",
      metadata: { runs: 2 },
    });
    expect(patch[1]).not.toHaveProperty("type");
    expect(patch[1]).not.toHaveProperty("task_id");
  });

  it("create_task refuses a missing intent or agent_id before the authz lookup", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools(TEAM, services);
    for (const input of [{}, { intent: "do it" }, { agent_id: "sub_1" }]) {
      const res = await callTool(tools, "create_task", input);
      expect(res.isError).toBe(true);
    }
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("create_task rejects an unknown priority after passing authz", async () => {
    const services = buildServices({
      agentRepo: {
        findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]),
      },
    });
    const tools = buildHierarchyTools(TEAM, services);
    const res = await callTool(tools, "create_task", {
      intent: "do it",
      agent_id: "sub_1",
      priority: "yesterday",
    });
    expect(res.isError).toBe(true);
    expect(String((res.content as { error: string }).error)).toContain("priority");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

/**
 * Every handler wraps its body in try/catch and returns the same
 * envelope. Agents branch on `error`, so a throw escaping as an MCP
 * transport error instead of a tool result would break that contract for
 * whichever tool regressed — hence one case per tool rather than a
 * single representative.
 */
describe("thrown errors become tool results, not transport failures", () => {
  const BOOM = new Error("pg down");
  const IC = { agentId: "agent_ic", hierarchyLevel: "ic" as HierarchyLevel };
  const TEAM = { agentId: "agent_t", hierarchyLevel: "team" as HierarchyLevel };

  const cases: Array<{
    tool: string;
    input: Record<string, unknown>;
    ctx: typeof IC;
    over: Parameters<typeof buildServices>[0];
  }> = [
    {
      tool: "search_context",
      input: { query: "auth" },
      ctx: IC,
      over: { memoryAgent: { searchArchival: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "update_progress",
      input: { task_id: "t1", status: "done" },
      ctx: IC,
      over: { taskService: { updateProgress: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "find_up",
      input: {},
      ctx: IC,
      over: { agentRepo: { findParent: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "get_agent_profile",
      input: { agent_id: "agent_x" },
      ctx: IC,
      over: { agentRepo: { findById: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "get_task",
      input: { task_id: "t1" },
      ctx: IC,
      over: { taskRepo: { findById: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "create_work_product",
      input: { task_id: "t1", title: "PR", type: "pull_request" },
      ctx: IC,
      over: { taskService: { createWorkProduct: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "list_work_products",
      input: { task_id: "t1" },
      ctx: IC,
      over: { taskService: { listWorkProducts: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "get_work_product",
      input: { id: "wp_1" },
      ctx: IC,
      over: { taskService: { getWorkProduct: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "update_work_product",
      input: { id: "wp_1", summary: "s" },
      ctx: IC,
      over: { taskService: { updateWorkProduct: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "find_subordinates",
      input: {},
      ctx: TEAM,
      over: { agentRepo: { findSubordinates: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "find_peers",
      input: {},
      ctx: TEAM,
      over: { agentRepo: { findPeers: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "create_task",
      input: { intent: "do it", agent_id: "sub_1" },
      ctx: TEAM,
      over: { agentRepo: { findSubordinates: vi.fn(async () => { throw BOOM; }) } },
    },
    {
      tool: "check_work_status",
      input: { agent_id: "agent_t" },
      ctx: TEAM,
      over: { taskRepo: { listByAssignee: vi.fn(async () => { throw BOOM; }) } },
    },
  ];

  for (const { tool, input, ctx, over } of cases) {
    it(`${tool} envelopes a service throw`, async () => {
      const tools = buildHierarchyTools(ctx, buildServices(over));
      const res = await callTool(tools, tool, input);
      expect(res.isError).toBe(true);
      // toolErrorFromThrown puts the human message in `error` on the
      // catch-all path (the coded path puts a stable code there).
      expect(res.content).toMatchObject({ error: "pg down" });
    });
  }
});
