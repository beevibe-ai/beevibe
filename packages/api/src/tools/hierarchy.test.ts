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
  Escalation,
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
  pool?: { query: ReturnType<typeof vi.fn> };
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    // `provisionAgent` (the real function, not a fake) writes through
    // this on create_subordinate_agent, so it echoes the input back.
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
    searchArchival: vi.fn(async () => "<archival_memory></archival_memory>"),
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

  const pool = (overrides.pool ?? {
    query: vi.fn(async () => ({ rows: [] })),
  }) as unknown as Pool;

  const coreMemoryRepo = {
    findByAgent: vi.fn(async () => []),
    updateContent: vi.fn(async () => undefined),
    // provisionAgent seeds the default blocks before the briefing
    // overwrites persona/domain.
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
// The canonical post-blocker unblock path, and the only tool whose authz
// is "caller is the assignee's *direct parent*" rather than a tier check.
// Every refusal below is a distinct way that check can fail, and each one
// has to refuse before `taskService.reviseTask` writes anything.

describe("revise_task", () => {
  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_parent", hierarchyLevel: "team" }, services);
  }

  it("requires both task_id and feedback", async () => {
    const services = buildServices();
    const tools = teamTools(services);

    for (const input of [
      {},
      { task_id: "t1" },
      { feedback: "do it differently" },
      { task_id: "", feedback: "x" },
    ]) {
      const result = await callTool(tools, "revise_task", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("task_id and feedback required");
    }
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses an unknown task", async () => {
    const services = buildServices({ taskRepo: { findById: vi.fn(async () => undefined) } });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "t_missing",
      feedback: "try again",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_not_found", task_id: "t_missing" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a task with no assignee — there is no parent edge to check", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: undefined })) },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "try again",
    });
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("refuses when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1" })) },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "try again",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "assignee_not_found" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    // The assignee reports to someone else — a sibling team agent must not
    // be able to steer another manager's subordinate.
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1" })) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_other", hierarchy_level: "ic" }),
        ),
      },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "try again",
    });
    expect(result.isError).toBe(true);
    const content = result.content as { error: string; message: string };
    expect(content.error).toBe("not_parent");
    expect(content.message).toContain("agent_parent");
    expect(content.message).toContain("sub_1");
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("revises and dispatches the revision session, reusing next_dispatch_context verbatim", async () => {
    const revision = {
      kind: "revision" as const,
      feedback: "use the retry helper",
      from_status: "blocked" as const,
      source: "parent_agent" as const,
    };
    const revised = fakeTask({
      id: "task_1",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: revision,
    });
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1", status: "blocked" })) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_parent", hierarchy_level: "ic" }),
        ),
      },
      taskService: { reviseTask: vi.fn(async () => revised) },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "use the retry helper",
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the retry helper",
      { source: "parent_agent", reviserAgentId: "agent_parent" },
    );
    // The ResumeReason handed to dispatch is the stamped context itself,
    // not a reconstruction of it — a rebuilt object would silently drop
    // any field reviseTask added.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ task: revised, agentId: "sub_1", reason: revision, type: "task" }),
    );
    // Post-#186 the status stays needs_revision until the daemon claims;
    // from_status reports where the task was before the revise.
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_1",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips dispatch when reviseTask stamped no revision context", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1" })) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_parent", hierarchy_level: "ic" }),
        ),
      },
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ status: "needs_revision", assignee_id: "sub_1", next_dispatch_context: undefined }),
        ),
      },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });
    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("maps InvalidTaskTransitionError onto the coded invalid_transition envelope", async () => {
    // Reviving a task that isn't blocked is the common case: the agent
    // sees a stable code rather than a raw exception message.
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask({ assignee_id: "sub_1", status: "done" })) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "sub_1", parent_agent_id: "agent_parent", hierarchy_level: "ic" }),
        ),
      },
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("done -> needs_revision is not allowed");
        }),
      },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_transition",
      message: "done -> needs_revision is not allowed",
    });
  });

  it("degrades any other throw to the catch-all envelope", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () => {
          throw new Error("pg: connection terminated");
        }),
      },
    });

    const result = await callTool(teamTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "pg: connection terminated" });
  });
});

// ── add_to_escalation (M6.4) ─────────────────────────────────────────────
//
// Called by the peer whose blocked respond_negotiate returned the
// 'escalated' sentinel. The handler's own logic is argument coercion over
// untyped MCP input plus the pg_notify refresh; the role/idempotency rules
// live in EscalationService.

describe("add_to_escalation", () => {
  function fakeEscalation(overrides: Partial<Escalation> = {}): Escalation {
    return {
      id: "esc_1",
      negotiation_id: "neg_1",
      initiator_session_id: "sess_a",
      counterparty_session_id: "sess_b",
      summary: "two valid designs, need a human call",
      initiator_open_questions: [],
      counterparty_open_questions: [],
      escalated_by_role: "initiator",
      status: "pending",
      created_at: new Date("2026-05-01"),
      updated_at: new Date("2026-05-01"),
      ...overrides,
    };
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_peer", hierarchyLevel: "team" }, services);
  }

  it("requires escalation_id", async () => {
    const services = buildServices();
    const result = await callTool(teamTools(services), "add_to_escalation", {});
    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("escalation_id required");
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("forwards the caller's proposals and questions, then refreshes listeners", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => fakeEscalation()),
      },
    });

    const proposals = [{ title: "Shard it", description: "by tenant", tradeoffs: "more ops" }];
    const result = await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals,
      open_questions: ["what is the retention window?"],
    });

    expect(result.isError).toBeFalsy();
    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      // The slot is picked by the service from the caller's role on the
      // negotiation — the tool never lets the agent name its own side.
      callerAgentId: "agent_peer",
      proposals,
      openQuestions: ["what is the retention window?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
  });

  it("drops non-array proposals and non-string questions from untyped input", async () => {
    const services = buildServices({
      escalationService: { addContribution: vi.fn(async () => fakeEscalation()) },
    });

    await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "not an array",
      open_questions: ["keep", 42, null, "also keep"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: ["keep", "also keep"] }),
    );
  });

  it("omits both optional arrays when neither is supplied", async () => {
    const services = buildServices({
      escalationService: { addContribution: vi.fn(async () => fakeEscalation()) },
    });

    await callTool(teamTools(services), "add_to_escalation", { escalation_id: "esc_1" });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ proposals: undefined, openQuestions: undefined }),
    );
  });

  it("reports both_sides_submitted only once both timestamps are set", async () => {
    // This flag is what tells the agent whether the human reviewer can
    // already act, so it must not read true off the caller's own write.
    const onlyMine = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({ counterparty_submitted_at: new Date("2026-05-01") }),
        ),
      },
    });
    const first = await callTool(teamTools(onlyMine), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(first.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });

    const both = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          fakeEscalation({
            initiator_submitted_at: new Date("2026-05-01"),
            counterparty_submitted_at: new Date("2026-05-01"),
          }),
        ),
      },
    });
    const second = await callTool(teamTools(both), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    // The row stays 'pending' until a human resolves it — the flag, not
    // the status, is what tells the agent both sides are in.
    expect(second.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
  });

  it("envelopes a service rejection instead of throwing out of the tool", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("caller already escalated; cannot also add_to_escalation");
        }),
      },
    });

    const result = await callTool(teamTools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "caller already escalated; cannot also add_to_escalation",
    });
    // The notify is downstream of the write — a failed contribution must
    // not announce an update that never happened.
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent (Phase 9) ───────────────────────────────────
//
// The spawn surface a team/org agent uses during onboarding. Every call
// writes an agent row, five core-memory blocks and an audit row, so the
// refusals in front of it are the only thing standing between a looping
// LLM and a fleet of junk agents. None of this was reachable from the
// existing suite.

describe("create_subordinate_agent", () => {
  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API and its database",
    persona: "A careful backend engineer.",
    domain: "Express routes, Postgres schema, migrations.",
  };

  function parentTools(
    services: ReturnType<typeof buildServices>,
    level: HierarchyLevel = "team",
  ) {
    return buildHierarchyTools({ agentId: "agent_parent", hierarchyLevel: level }, services);
  }

  function withParent(parent = fakeAgent({ id: "agent_parent" }), extra = {}) {
    return buildServices({
      agentRepo: { findById: vi.fn(async () => parent) },
      ...extra,
    });
  }

  // NOTE: the handler opens with an `ic_cannot_spawn` guard, but
  // `buildHierarchyTools` never hands the tool to an IC ctx in the first
  // place, so that branch is unreachable from the public entry point and
  // is left uncovered deliberately. The tier gate below is the behaviour
  // that actually protects the invariant.
  it("is absent from the IC tool set — ICs cannot spawn ICs", async () => {
    const services = withParent();
    const icTools = buildHierarchyTools({ agentId: "agent_ic", hierarchyLevel: "ic" }, services);
    expect(icTools.some((t) => t.name === "create_subordinate_agent")).toBe(false);

    for (const level of ["team", "org"] as const) {
      const tools = buildHierarchyTools({ agentId: "agent_p", hierarchyLevel: level }, services);
      expect(tools.some((t) => t.name === "create_subordinate_agent")).toBe(true);
    }
  });

  it("requires name, tag_line, persona and domain", async () => {
    const services = withParent();
    const tools = parentTools(services);

    for (const missing of ["name", "tag_line", "persona", "domain"] as const) {
      const input: Record<string, unknown> = { ...VALID };
      delete input[missing];
      const result = await callTool(tools, "create_subordinate_agent", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("missing_required_fields");
    }
    // Whitespace-only is treated as absent — the fields are trimmed first.
    const blank = await callTool(tools, "create_subordinate_agent", { ...VALID, persona: "   " });
    expect((blank.content as { error: string }).error).toBe("missing_required_fields");
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("trims the briefing fields before storing them", async () => {
    const services = withParent();
    await callTool(parentTools(services), "create_subordinate_agent", {
      name: "  Padded  ",
      tag_line: "  line  ",
      persona: "  p  ",
      domain: "  d  ",
    });

    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Padded" }),
    );
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
      expect.any(String),
      "persona",
      "p",
    );
  });

  it("caps tag_line at 100 chars so the agent card stays on one line", async () => {
    const services = withParent();
    const result = await callTool(parentTools(services), "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(101),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "tag_line_too_long",
      message: "tag_line must be ≤100 chars",
      actual: 101,
    });

    // 100 exactly is allowed — the check is strictly greater-than.
    const ok = await callTool(parentTools(withParent()), "create_subordinate_agent", {
      ...VALID,
      tag_line: "x".repeat(100),
    });
    expect(ok.isError).toBeFalsy();
  });

  it("rejects an over-long name and any control character in it", async () => {
    const services = withParent();
    const tools = parentTools(services);

    const long = await callTool(tools, "create_subordinate_agent", {
      ...VALID,
      name: "n".repeat(81),
    });
    expect((long.content as { error: string }).error).toBe("invalid_name");

    // Newlines and NULs would break the dropdown and the
    // `system_prompt_addition` line the name is interpolated into.
    for (const bad of ["Back\nend", "Back\u0000end", "Back\u007fend", "Tab\there"]) {
      const result = await callTool(tools, "create_subordinate_agent", { ...VALID, name: bad });
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("invalid_name");
    }
    expect(services.agentRepo.create).not.toHaveBeenCalled();

    // Punctuation and ampersands are deliberately fine — the LLM picks
    // natural role names.
    const natural = await callTool(parentTools(withParent()), "create_subordinate_agent", {
      ...VALID,
      name: "Web & Onboarding specialist",
    });
    expect(natural.isError).toBeFalsy();
  });

  it("refuses when the calling agent's own row is missing", async () => {
    const services = buildServices({ agentRepo: { findById: vi.fn(async () => undefined) } });
    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "parent_not_found", agent_id: "agent_parent" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("enforces the per-parent 24h spawn cap", async () => {
    const services = withParent(fakeAgent({ id: "agent_parent", name: "Lead" }), {
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });

    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);
    expect(result.isError).toBe(true);
    const content = result.content as { error: string; cap: number; count: number; message: string };
    expect(content.error).toBe("subordinate_daily_cap");
    expect(content.cap).toBe(8);
    expect(content.count).toBe(8);
    expect(content.message).toContain("Lead");
    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      "agent_parent",
      24 * 60 * 60,
    );
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("allows the spawn at one below the cap", async () => {
    const services = withParent(fakeAgent({ id: "agent_parent" }), {
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);
    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalled();
  });

  it("creates the IC under the parent, inheriting owner and runtime", async () => {
    const parent = fakeAgent({
      id: "agent_parent",
      owner_id: "person_42",
      runtime_config: { type: "claude", model: "opus" },
      preferred_runtime_id: "rt_1",
    });
    const services = withParent(parent);

    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Backend specialist",
        // Same human owns the child; same daemon runs it.
        owner_id: "person_42",
        parent_agent_id: "agent_parent",
        hierarchy_level: "ic",
        preferred_runtime_id: "rt_1",
      }),
    );
    const created = vi.mocked(services.agentRepo.create).mock.calls[0]![0] as unknown as {
      runtime_config: Record<string, unknown>;
    };
    // Parent's runtime wins over the defaults, but the prompt addition is
    // always rewritten to this child's name — inheriting the parent's
    // would give the child the parent's identity.
    expect(created.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      system_prompt_addition: "You are Backend specialist.",
    });

    const content = result.content as { created: Record<string, unknown> };
    expect(content.created).toMatchObject({
      name: "Backend specialist",
      hierarchy_level: "ic",
      parent_agent_id: "agent_parent",
    });
    expect(content.created.id).toEqual(expect.any(String));
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    // Passing an explicit undefined would still key the column in the
    // insert; the spread is conditional for that reason.
    const services = withParent(fakeAgent({ id: "agent_parent", preferred_runtime_id: undefined }));
    await callTool(parentTools(services), "create_subordinate_agent", VALID);

    const input = vi.mocked(services.agentRepo.create).mock.calls[0]![0] as Record<string, unknown>;
    expect("preferred_runtime_id" in input).toBe(false);
  });

  it("seeds the three mandatory blocks and skips the optional ones when blank", async () => {
    const services = withParent();
    await callTool(parentTools(services), "create_subordinate_agent", VALID);

    const blocks = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map(([, name]) => name);
    expect(blocks.sort()).toEqual(["domain", "persona", "tag_line"]);
  });

  it("seeds active_context and constraints when the parent supplies them", async () => {
    const services = withParent();
    await callTool(parentTools(services), "create_subordinate_agent", {
      ...VALID,
      active_context: "Migrating the auth tables.",
      constraints: "Never touch billing.",
    });

    const seeded = new Map(
      vi
        .mocked(services.coreMemoryRepo.updateContent)
        .mock.calls.map(([, name, content]) => [name, content]),
    );
    expect(seeded.get("active_context")).toBe("Migrating the auth tables.");
    expect(seeded.get("constraints")).toBe("Never touch billing.");
    expect(seeded.size).toBe(5);
  });

  it("writes the audit row that backs the cap query and the agents-page panel", async () => {
    const parent = fakeAgent({ id: "agent_parent", owner_id: "person_42" });
    const services = withParent(parent);

    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);
    const childId = (result.content as { created: { id: string } }).created.id;

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_parent",
        child_agent_id: childId,
        owner_person_id: "person_42",
        child_name: "Backend specialist",
        persona: VALID.persona,
        domain: VALID.domain,
      }),
    );
  });

  it("still reports the spawn when only the audit row fails", async () => {
    // The agent and its memory are the user-visible artifacts; losing the
    // audit row must not strand a provisioned agent behind an error.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const services = withParent(fakeAgent({ id: "agent_parent" }), {
      agentProvisionEventRepo: {
        countByParentSince: vi.fn(async () => 0),
        create: vi.fn(async () => {
          throw new Error("agent_provision_event insert failed");
        }),
      },
    });

    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);

    expect(result.isError).toBeFalsy();
    expect((result.content as { created: { name: string } }).created.name).toBe(
      "Backend specialist",
    );
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining("[create_subordinate_agent] audit row failed"),
      "agent_provision_event insert failed",
    );
    consoleErr.mockRestore();
  });

  it("envelopes a failure in the agent insert itself", async () => {
    const services = buildServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent({ id: "agent_parent" })),
        create: vi.fn(async () => {
          throw new Error("duplicate key value violates unique constraint");
        }),
      },
    });

    const result = await callTool(parentTools(services), "create_subordinate_agent", VALID);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "duplicate key value violates unique constraint",
    });
    expect(services.agentProvisionEventRepo.create).not.toHaveBeenCalled();
  });

  it("exposes the IC block templates as its own field descriptions", async () => {
    // The tool's per-field guidance and the <core_memory> block
    // descriptions the IC will read must come from one source, or the
    // parent is briefed against a schema the child doesn't have.
    const tools = parentTools(withParent());
    const schema = findTool(tools, "create_subordinate_agent").schema as {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
    const icTemplates = new Map(
      DEFAULT_BLOCK_TEMPLATES.ic.map((t) => [t.block_name, t.description]),
    );
    for (const block of ["persona", "domain", "active_context", "constraints"]) {
      expect(schema.properties[block]?.description).toBe(icTemplates.get(block) ?? "");
    }
    expect(schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
  });
});

// ── Input validation the schema can't enforce ────────────────────────────
//
// MCP input arrives untyped: the `required` / `enum` lists in each schema
// are guidance to the model, not a validator. These guards are the real
// boundary, and each one refuses before any write.

describe("argument guards", () => {
  const ic = (services: ReturnType<typeof buildServices>) =>
    buildHierarchyTools({ agentId: "agent_a", hierarchyLevel: "ic" }, services);
  const team = (services: ReturnType<typeof buildServices>) =>
    buildHierarchyTools({ agentId: "agent_t", hierarchyLevel: "team" }, services);

  it("search_context rejects a blank or whitespace-only query", async () => {
    const services = buildServices();
    for (const query of [undefined, "", "   "]) {
      const result = await callTool(ic(services), "search_context", { query });
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe(
        "query must be a non-empty string",
      );
    }
    expect(services.memoryAgent.searchArchival).not.toHaveBeenCalled();
  });

  it("create_work_product requires task_id and title, then a known type", async () => {
    const services = buildServices();
    const tools = ic(services);

    for (const input of [{ type: "document", title: "T" }, { type: "document", task_id: "t1" }]) {
      const result = await callTool(tools, "create_work_product", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("task_id and title required");
    }

    const badType = await callTool(tools, "create_work_product", {
      task_id: "t1",
      title: "T",
      type: "interpretive_dance",
    });
    expect(badType.isError).toBe(true);
    expect((badType.content as { error: string }).error).toContain("type must be one of");
    expect(services.taskService.createWorkProduct).not.toHaveBeenCalled();
  });

  it("create_work_product passes through the optional fields and drops non-object metadata", async () => {
    const services = buildServices();
    const result = await callTool(ic(services), "create_work_product", {
      task_id: "t1",
      type: "pull_request",
      title: "Add retries",
      summary: "why",
      body: "the diff",
      url: "https://github.com/o/r/pull/1",
      provider: "github",
      external_id: "1",
      metadata: { lines: 12 },
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "t1",
        agent_id: "agent_a",
        type: "pull_request",
        title: "Add retries",
        summary: "why",
        body: "the diff",
        url: "https://github.com/o/r/pull/1",
        provider: "github",
        external_id: "1",
        metadata: { lines: 12 },
      }),
    );
    expect(result.content).toEqual({
      created: { id: expect.any(String), type: "pull_request", title: "Add retries", task_id: "t1" },
    });

    // A string where an object was documented would otherwise reach the
    // jsonb column as a bare scalar.
    const coerced = buildServices();
    await callTool(ic(coerced), "create_work_product", {
      task_id: "t1",
      type: "document",
      title: "T",
      metadata: "nope",
    });
    expect(coerced.taskService.createWorkProduct).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: undefined }),
    );
  });

  it("update_work_product requires an id and drops non-object metadata", async () => {
    const services = buildServices();
    const blank = await callTool(ic(services), "update_work_product", { id: "" });
    expect(blank.isError).toBe(true);
    expect((blank.content as { error: string }).error).toBe("id required");
    expect(services.taskService.updateWorkProduct).not.toHaveBeenCalled();

    await callTool(ic(services), "update_work_product", {
      id: "wp_1",
      summary: "new",
      metadata: ["array", "is", "an", "object"],
    });
    expect(services.taskService.updateWorkProduct).toHaveBeenCalledWith("wp_1", {
      summary: "new",
      body: undefined,
      url: undefined,
      provider: undefined,
      external_id: undefined,
      // Arrays are `typeof === "object"`, so they pass the guard as-is —
      // pinned as current behaviour rather than asserted as intended.
      metadata: ["array", "is", "an", "object"],
    });
  });

  it("get_work_product requires an id and reports a missing row", async () => {
    const services = buildServices();
    const blank = await callTool(ic(services), "get_work_product", {});
    expect((blank.content as { error: string }).error).toBe("id required");

    const missing = await callTool(ic(services), "get_work_product", { id: "wp_404" });
    expect(missing.isError).toBe(true);
    expect((missing.content as { error: string }).error).toBe("work_product wp_404 not found");
  });

  it("get_task projects a found task and returns null for a missing one", async () => {
    const found = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ id: "t1", description: undefined, assignee_id: "agent_a" }),
        ),
      },
    });
    const result = await callTool(ic(found), "get_task", { task_id: "t1" });
    expect(result.isError).toBeFalsy();
    // Optional columns are normalized to null so the wire shape is stable
    // whether or not the row had them.
    expect((result.content as { task: Record<string, unknown> }).task).toMatchObject({
      id: "t1",
      title: "Build X",
      description: null,
      status: "in_progress",
      assignee_id: "agent_a",
    });

    const missing = buildServices();
    const none = await callTool(ic(missing), "get_task", { task_id: "t_404" });
    expect(none.content).toEqual({ task: null });
  });

  it("create_task requires intent and agent_id, and validates priority", async () => {
    const sub = fakeAgent({ id: "sub_1", hierarchy_level: "ic" });
    const services = buildServices({
      agentRepo: { findSubordinates: vi.fn(async () => [sub]) },
    });
    const tools = team(services);

    for (const input of [{ agent_id: "sub_1" }, { intent: "x" }, {}]) {
      const result = await callTool(tools, "create_task", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe("intent and agent_id required");
    }
    expect(services.agentRepo.findSubordinates).not.toHaveBeenCalled();

    const badPriority = await callTool(tools, "create_task", {
      intent: "x",
      agent_id: "sub_1",
      priority: "yesterday",
    });
    expect(badPriority.isError).toBe(true);
    expect((badPriority.content as { error: string }).error).toContain("priority must be one of");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("update_progress refuses every status an agent must not self-assign", async () => {
    const services = buildServices();
    for (const status of ["in_progress", "assigned", "pending", "cancelled", "needs_revision", "revision", undefined]) {
      const result = await callTool(ic(services), "update_progress", {
        task_id: "t1",
        status,
        summary: "s",
      });
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toContain("status must be one of");
    }
    expect(services.taskService.updateProgress).not.toHaveBeenCalled();
  });
});

// ── Catch-all envelopes ──────────────────────────────────────────────────
//
// Every handler wraps its body in try/catch and reports an unexpected
// throw as `{ error: <message> }` with isError. A handler that let the
// exception escape instead would surface to the agent as an MCP transport
// error with no message, which is the hardest failure mode to debug from
// a session transcript. One case per handler, driven off whichever
// dependency it reaches first.

describe("unexpected throws become tool error envelopes", () => {
  const boom = () => {
    throw new Error("pg: terminating connection due to administrator command");
  };

  const cases: Array<{
    tool: string;
    level: HierarchyLevel;
    input: Record<string, unknown>;
    services: () => ReturnType<typeof buildServices>;
  }> = [
    {
      tool: "search_context",
      level: "ic",
      input: { query: "retries" },
      services: () => buildServices({ memoryAgent: { searchArchival: vi.fn(boom) } }),
    },
    {
      tool: "update_progress",
      level: "ic",
      input: { task_id: "t1", status: "done", summary: "s" },
      services: () => buildServices({ taskService: { updateProgress: vi.fn(boom) } }),
    },
    {
      tool: "find_up",
      level: "ic",
      input: {},
      services: () => buildServices({ agentRepo: { findParent: vi.fn(boom) } }),
    },
    {
      tool: "get_agent_profile",
      level: "ic",
      input: { agent_id: "agent_b" },
      services: () => buildServices({ agentRepo: { findById: vi.fn(boom) } }),
    },
    {
      tool: "get_task",
      level: "ic",
      input: { task_id: "t1" },
      services: () => buildServices({ taskRepo: { findById: vi.fn(boom) } }),
    },
    {
      tool: "create_work_product",
      level: "ic",
      input: { task_id: "t1", type: "document", title: "T" },
      services: () => buildServices({ taskService: { createWorkProduct: vi.fn(boom) } }),
    },
    {
      tool: "list_work_products",
      level: "ic",
      input: { task_id: "t1" },
      services: () => buildServices({ taskService: { listWorkProducts: vi.fn(boom) } }),
    },
    {
      tool: "get_work_product",
      level: "ic",
      input: { id: "wp_1" },
      services: () => buildServices({ taskService: { getWorkProduct: vi.fn(boom) } }),
    },
    {
      tool: "update_work_product",
      level: "ic",
      input: { id: "wp_1" },
      services: () => buildServices({ taskService: { updateWorkProduct: vi.fn(boom) } }),
    },
    {
      tool: "find_subordinates",
      level: "team",
      input: {},
      services: () => buildServices({ agentRepo: { findSubordinates: vi.fn(boom) } }),
    },
    {
      tool: "find_peers",
      level: "team",
      input: {},
      services: () => buildServices({ agentRepo: { findPeers: vi.fn(boom) } }),
    },
    {
      tool: "create_task",
      level: "team",
      input: { intent: "x", agent_id: "sub_1" },
      services: () =>
        buildServices({
          agentRepo: { findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]) },
          taskRepo: { create: vi.fn(boom) },
        }),
    },
    {
      tool: "check_work_status",
      level: "team",
      input: { agent_id: "agent_t" },
      services: () => buildServices({ taskRepo: { listByAssignee: vi.fn(boom) } }),
    },
  ];

  for (const c of cases) {
    it(`${c.tool} reports the throw instead of escaping`, async () => {
      const tools = buildHierarchyTools(
        { agentId: c.level === "ic" ? "agent_a" : "agent_t", hierarchyLevel: c.level },
        c.services(),
      );
      const result = await callTool(tools, c.tool, c.input);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual({
        error: "pg: terminating connection due to administrator command",
      });
    });
  }
});
