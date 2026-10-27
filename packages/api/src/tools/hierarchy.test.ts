/**
 * Hierarchy / work-product tools — unit tests with vitest fakes (no DB).
 *
 * Covers the IC-shared and team-only tools plus the IC vs team set gating
 * in `buildHierarchyTools`. Each tool's handler is a thin closure over
 * (ctx, services); the fakes here exercise auth + delegation.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_TEMPLATES, TASK_PRIORITIES } from "@beevibe/core";
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

/** Only the fields add_to_escalation reads off the service's return. */
function fakeEscalation(overrides: Record<string, unknown> = {}): Escalation {
  return {
    id: "esc_1",
    status: "pending",
    ...overrides,
  } as unknown as Escalation;
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
    // `provisionAgent` (create_subordinate_agent) inserts through the repo
    // rather than a service, so the fake has to mint the row itself.
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

// ── revise_task ──────────────────────────────────────────────────────────

describe("revise_task", () => {
  const PARENT = "agent_parent";

  /** Parent of PARENT's subordinate, blocked on the task under revision. */
  function revisableServices(
    overrides: Parameters<typeof buildServices>[0] = {},
    taskOverrides: Partial<Task> = {},
  ) {
    const revised = fakeTask({
      status: "needs_revision",
      assignee_id: "agent_sub",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the staging key",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: PARENT,
      },
    });
    return buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ status: "blocked", assignee_id: "agent_sub", ...taskOverrides }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_sub", hierarchy_level: "ic", parent_agent_id: PARENT }),
        ),
      },
      taskService: { reviseTask: vi.fn(async () => revised) },
      ...overrides,
    });
  }

  function parentTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: PARENT, hierarchyLevel: "team" }, services);
  }

  it("revises the task and dispatches the revision session with the stamped context", async () => {
    const services = revisableServices();
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "use the staging key",
    });

    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the staging key",
      { source: "parent_agent", reviserAgentId: PARENT },
    );
    const dispatched = vi.mocked(services.dispatchService.dispatchTask).mock
      .calls[0]?.[0];
    expect(dispatched).toMatchObject({
      agentId: "agent_sub",
      type: "task",
      reason: { kind: "revision", from_status: "blocked" },
    });
    // The intent carries the parent's feedback — that is the whole point of
    // the revision block the resumed session reads.
    expect(dispatched?.intent).toContain("use the staging key");
    expect(dispatched?.intent).toContain('type="revision"');

    expect(result.isError).toBeFalsy();
    // Post-#186 the status stays at needs_revision until the daemon claims.
    expect(result.content).toEqual({
      revised: true,
      task_id: "task_1",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({ status: "needs_revision", assignee_id: "agent_sub" }),
        ),
      },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(result.content).toMatchObject({ revised: true });
  });

  it.each([
    ["task_id", { feedback: "f" }],
    ["feedback", { task_id: "task_1" }],
  ])("refuses without %s", async (_label, input) => {
    const services = revisableServices();
    const result = await callTool(parentTools(services), "revise_task", input);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "task_id and feedback required" });
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s on an unknown task, echoing the id back", async () => {
    const services = revisableServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_gone",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "task_not_found",
      task_id: "task_gone",
    });
  });

  it("refuses an unassigned task — there is no subordinate to unblock", async () => {
    const services = revisableServices({}, { assignee_id: undefined });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "task_unassigned" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses when the assignee row has gone missing", async () => {
    const services = revisableServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "assignee_not_found" });
  });

  // Authz is the reason this tool is team-only: a peer or grandparent
  // must not be able to steer someone else's subordinate.
  it.each([
    ["a grandparent", "agent_grandparent"],
    ["an unrelated agent", undefined],
  ])("refuses a caller who is not the assignee's direct parent (%s)", async (
    _label,
    parent_agent_id,
  ) => {
    const services = revisableServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_sub", hierarchy_level: "ic", parent_agent_id }),
        ),
      },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect((result.content as { message: string }).message).toContain(PARENT);
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("maps InvalidTaskTransitionError onto the invalid_transition code", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError("Cannot revise task in status 'done'");
        }),
      },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_transition",
      message: "Cannot revise task in status 'done'",
    });
  });

  it("falls back to the catch-all envelope on any other throw", async () => {
    const services = revisableServices({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("connection terminated");
        }),
      },
    });
    const result = await callTool(parentTools(services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.content).toEqual({ error: "connection terminated" });
  });
});

// ── add_to_escalation ────────────────────────────────────────────────────

describe("add_to_escalation", () => {
  function tools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools({ agentId: "agent_b", hierarchyLevel: "team" }, services);
  }

  it("adds the caller's contribution, then notifies escalation_updated", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => fakeEscalation({
          initiator_submitted_at: new Date("2026-04-01"),
          counterparty_submitted_at: new Date("2026-04-02"),
        })),
      },
    });
    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "Hold", description: "Wait for Q3" }],
      open_questions: ["Is the deadline hard?"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_b",
      proposals: [{ title: "Hold", description: "Wait for Q3" }],
      openQuestions: ["Is the deadline hard?"],
    });
    expect(vi.mocked(services.pool.query).mock.calls[0]?.[0]).toContain(
      "pg_notify('escalation_updated'",
    );
    expect(vi.mocked(services.pool.query).mock.calls[0]?.[1]).toEqual(["esc_1"]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: true,
    });
  });

  // The flag is what tells the agent whether a human can act yet, so each
  // half-submitted combination is pinned.
  it.each([
    ["only the initiator has", { initiator_submitted_at: new Date() }],
    ["only the counterparty has", { counterparty_submitted_at: new Date() }],
    ["neither has", {}],
  ])("reports both_sides_submitted false when %s submitted", async (_label, stamps) => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => fakeEscalation(stamps)),
      },
    });
    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.content).toMatchObject({ both_sides_submitted: false });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("refuses an escalation_id that is %s", async (_label, escalation_id) => {
    const services = buildServices();
    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "escalation_id required" });
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("sends undefined for proposals and open_questions that are not arrays", async () => {
    const services = buildServices();
    await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: { title: "Hold" },
      open_questions: "just one",
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_b",
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("filters non-strings out of open_questions", async () => {
    const services = buildServices();
    await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real?", 42, null, "also real?"],
    });

    expect(
      vi.mocked(services.escalationService.addContribution).mock.calls[0]?.[0],
    ).toMatchObject({ openQuestions: ["real?", "also real?"] });
  });

  it("does not notify when the contribution itself was rejected", async () => {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("agent_b already submitted");
        }),
      },
    });
    const result = await callTool(tools(services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "agent_b already submitted" });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent ─────────────────────────────────────────────

describe("create_subordinate_agent", () => {
  const PARENT = fakeAgent({
    id: "agent_team",
    name: "Team lead",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude", model: "sonnet" },
  });

  const BRIEF = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, writes tests first.",
    domain: "Express + Postgres in packages/api.",
  };

  function spawnServices(overrides: Parameters<typeof buildServices>[0] = {}) {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () => PARENT),
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
      ...overrides,
    });
  }

  function teamTools(services: ReturnType<typeof buildServices>) {
    return buildHierarchyTools(
      { agentId: PARENT.id, hierarchyLevel: "team" },
      services,
    );
  }

  it("provisions an IC under the caller and returns its projection", async () => {
    const services = spawnServices();
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    const created = vi.mocked(services.agentRepo.create).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      name: BRIEF.name,
      owner_id: PARENT.owner_id,
      parent_agent_id: PARENT.id,
      hierarchy_level: "ic",
      // provisionAgent's default, not something the parent chooses.
      review_policy: "auto_done",
    });
    expect(created?.id).toMatch(/^agent_/);
    expect(created?.api_key).toBeTruthy();

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({
      created: {
        id: created?.id,
        name: BRIEF.name,
        hierarchy_level: "ic",
        parent_agent_id: PARENT.id,
      },
    });
  });

  it("inherits the parent's runtime config but rewrites the system prompt addition", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", BRIEF);

    expect(
      vi.mocked(services.agentRepo.create).mock.calls[0]?.[0].runtime_config,
    ).toMatchObject({
      type: "claude",
      model: "sonnet",
      // Name only — the persona description lives in core memory.
      system_prompt_addition: `You are ${BRIEF.name}.`,
    });
  });

  it("pins the child to the parent's runtime when the parent has one", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ ...PARENT, preferred_runtime_id: "rt_1" }),
        ),
        create: vi.fn(async (input: Partial<Agent>) => fakeAgent(input)),
      },
    });
    await callTool(teamTools(services), "create_subordinate_agent", BRIEF);

    expect(
      vi.mocked(services.agentRepo.create).mock.calls[0]?.[0],
    ).toMatchObject({ preferred_runtime_id: "rt_1" });
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", BRIEF);

    expect(
      vi.mocked(services.agentRepo.create).mock.calls[0]?.[0],
    ).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds the three required core-memory blocks and leaves the optional ones empty", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", BRIEF);

    expect(services.coreMemoryRepo.initDefaults).toHaveBeenCalledWith(
      expect.stringMatching(/^agent_/),
      "ic",
    );
    const written = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map(([, block, content]) => [block, content]);
    expect(written).toEqual([
      ["tag_line", BRIEF.tag_line],
      ["persona", BRIEF.persona],
      ["domain", BRIEF.domain],
    ]);
  });

  it("seeds active_context and constraints when the parent supplies them", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", {
      ...BRIEF,
      active_context: "Shipping the billing rewrite.",
      constraints: "No schema changes without review.",
    });

    const blocks = vi
      .mocked(services.coreMemoryRepo.updateContent)
      .mock.calls.map(([, block]) => block);
    expect(blocks).toEqual([
      "tag_line",
      "persona",
      "domain",
      "active_context",
      "constraints",
    ]);
  });

  it("trims every field before it reaches the agent row and core memory", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", {
      name: `  ${BRIEF.name}  `,
      tag_line: `\t${BRIEF.tag_line}\n`,
      persona: `  ${BRIEF.persona}  `,
      domain: `  ${BRIEF.domain}  `,
    });

    expect(vi.mocked(services.agentRepo.create).mock.calls[0]?.[0]).toMatchObject({
      name: BRIEF.name,
    });
    expect(services.coreMemoryRepo.updateContent).toHaveBeenCalledWith(
      expect.any(String),
      "tag_line",
      BRIEF.tag_line,
    );
  });

  it("writes the audit row that backs the daily cap and the agents-page panel", async () => {
    const services = spawnServices();
    await callTool(teamTools(services), "create_subordinate_agent", BRIEF);

    const event = vi.mocked(services.agentProvisionEventRepo.create).mock
      .calls[0]?.[0];
    expect(event).toMatchObject({
      parent_agent_id: PARENT.id,
      owner_person_id: PARENT.owner_id,
      child_name: BRIEF.name,
      persona: BRIEF.persona,
      domain: BRIEF.domain,
    });
    expect(event?.id).toMatch(/^ape_/);
    expect(event?.child_agent_id).toMatch(/^agent_/);
  });

  // The agent and its memory are the user-visible artifacts; losing the
  // audit row must not lose the spawn.
  it("still reports success when the audit row fails to write", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: {
        create: vi.fn(async () => {
          throw new Error("audit table is read-only");
        }),
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ created: { name: BRIEF.name } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // The handler also carries an `ic_cannot_spawn` guard, but assembly
  // never hands an IC the tool, so that branch is unreachable from here —
  // the tier set is the enforcement worth pinning.
  it("is absent from the IC tool set", () => {
    const names = buildHierarchyTools(
      { agentId: "agent_ic", hierarchyLevel: "ic" },
      spawnServices(),
    ).map((t) => t.name);

    expect(names).not.toContain("create_subordinate_agent");
  });

  it.each([
    ["name", { ...BRIEF, name: "" }],
    ["tag_line", { ...BRIEF, tag_line: "   " }],
    ["persona", { ...BRIEF, persona: undefined }],
    ["domain", { ...BRIEF, domain: "" }],
  ])("refuses a brief missing %s", async (_label, input) => {
    const services = spawnServices();
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      input,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_required_fields" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("refuses a tag_line over 100 chars, reporting the actual length", async () => {
    const services = spawnServices();
    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...BRIEF,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "tag_line_too_long",
      message: "tag_line must be ≤100 chars",
      actual: 101,
    });
  });

  it("accepts a tag_line of exactly 100 chars", async () => {
    const services = spawnServices();
    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...BRIEF,
      tag_line: "x".repeat(100),
    });

    expect(result.isError).toBeFalsy();
  });

  it.each([
    ["over 80 chars", "n".repeat(81)],
    ["carrying a NUL", "Backend\u0000specialist"],
    ["carrying a newline", "Backend\nspecialist"],
    ["carrying DEL", "Backend\u007fspecialist"],
  ])("refuses a name %s", async (_label, name) => {
    const services = spawnServices();
    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...BRIEF,
      name,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_name" });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 80 chars", async () => {
    const services = spawnServices();
    const result = await callTool(teamTools(services), "create_subordinate_agent", {
      ...BRIEF,
      name: "n".repeat(80),
    });

    expect(result.isError).toBeFalsy();
  });

  it("404s when the calling parent cannot be resolved", async () => {
    const services = spawnServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "parent_not_found",
      agent_id: PARENT.id,
    });
  });

  it("enforces the per-parent daily cap, reporting the cap and the count", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 8) },
    });
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(services.agentProvisionEventRepo.countByParentSince).toHaveBeenCalledWith(
      PARENT.id,
      86_400,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("allows the spawn one below the cap", async () => {
    const services = spawnServices({
      agentProvisionEventRepo: { countByParentSince: vi.fn(async () => 7) },
    });
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalled();
  });

  it("envelopes a failure from the provision insert", async () => {
    const services = spawnServices({
      agentRepo: {
        findById: vi.fn(async () => PARENT),
        create: vi.fn(async () => {
          throw new Error("duplicate api_key");
        }),
      },
    });
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "duplicate api_key" });
    expect(services.coreMemoryRepo.updateContent).not.toHaveBeenCalled();
  });

  it("envelopes a failure from seeding core memory", async () => {
    const services = spawnServices({
      coreMemoryRepo: {
        initDefaults: vi.fn(async () => []),
        updateContent: vi.fn(async () => {
          throw new Error("block char_limit exceeded");
        }),
      },
    });
    const result = await callTool(
      teamTools(services),
      "create_subordinate_agent",
      BRIEF,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "block char_limit exceeded" });
  });

  it("derives its per-field descriptions from the IC block templates", () => {
    const services = spawnServices();
    const tool = findTool(teamTools(services), "create_subordinate_agent");
    const props = tool.schema.properties as Record<string, { description: string }>;

    expect(tool.schema.required).toEqual(["name", "tag_line", "persona", "domain"]);
    for (const block of ["tag_line", "persona", "domain", "active_context", "constraints"]) {
      const template = DEFAULT_BLOCK_TEMPLATES.ic.find((t) => t.block_name === block);
      expect(props[block]?.description).toBe(template?.description ?? "");
    }
  });
});

// ── Required-argument guards ─────────────────────────────────────────────

/**
 * Every handler coerces its ids with `String(input.x ?? "")` and refuses the
 * empty result. The table keeps that refusal honest tool-by-tool: a guard
 * that silently stopped firing would let `""` through to a repo call, and
 * `findById("")` returns undefined rather than throwing, so the agent would
 * get a plausible-looking null instead of an error.
 */
describe("missing-argument guards", () => {
  const CASES: Array<[tool: string, input: Record<string, unknown>, error: string]> = [
    ["search_context", {}, "query must be a non-empty string"],
    ["search_context", { query: "   " }, "query must be a non-empty string"],
    ["get_agent_profile", {}, "agent_id required"],
    ["get_task", {}, "task_id required"],
    ["list_work_products", {}, "task_id required"],
    ["get_work_product", {}, "id required"],
    ["update_work_product", {}, "id required"],
    ["create_work_product", { type: "pull_request", title: "t" }, "task_id and title required"],
    ["create_work_product", { task_id: "task_1", type: "pull_request" }, "task_id and title required"],
    ["create_task", { agent_id: "sub_1" }, "intent and agent_id required"],
    ["create_task", { intent: "do it" }, "intent and agent_id required"],
    ["check_work_status", {}, "agent_id required"],
  ];

  it.each(CASES)("%s refuses %j", async (name, input, error) => {
    const services = buildServices();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, name, input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error });
  });

  it("update_progress refuses a status outside the agent-settable set", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "update_progress", { task_id: "t1" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "status must be one of: done, failed, blocked",
    });
    expect(services.taskService.updateProgress).not.toHaveBeenCalled();
  });

  it("create_task refuses an unknown priority after the authz check", async () => {
    const services = buildServices({
      agentRepo: {
        findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, "create_task", {
      intent: "do it",
      agent_id: "sub_1",
      priority: "urgent",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: `priority must be one of: ${TASK_PRIORITIES.join(", ")}`,
    });
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("get_work_product 404s with the id in the message", async () => {
    const services = buildServices({
      taskService: { getWorkProduct: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_work_product", { id: "wp_gone" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "work_product wp_gone not found" });
  });
});

// ── Projections ──────────────────────────────────────────────────────────

describe("projections", () => {
  it("get_task nulls every absent optional field and serializes the timestamps", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => fakeTask()) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_1" });
    expect(result.content.task).toEqual({
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

  it("get_task passes every populated optional field through", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({
            description: "with detail",
            assignee_id: "agent_sub",
            parent_task_id: "task_parent",
            repo_url: "https://github.com/acme/app",
            result_summary: "shipped",
            status: "blocked",
            blocker_agent_id: "agent_sub",
            blocker_reason: "missing key",
          }),
        ),
      },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_task", { task_id: "task_1" });
    expect(result.content.task).toMatchObject({
      description: "with detail",
      assignee_id: "agent_sub",
      parent_task_id: "task_parent",
      repo_url: "https://github.com/acme/app",
      result_summary: "shipped",
      blocker_agent_id: "agent_sub",
      blocker_reason: "missing key",
    });
  });

  it("get_agent_profile nulls a top-level agent's parent", async () => {
    const services = buildServices({
      agentRepo: { findById: vi.fn(async () => fakeAgent({ id: "agent_top" })) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_agent_profile", { agent_id: "agent_top" });
    expect(result.content.agent).toEqual({
      id: "agent_top",
      name: "A",
      hierarchy_level: "team",
      parent_agent_id: null,
      owner_id: "person_1",
    });
  });

  it("list_work_products nulls absent url and summary", async () => {
    const services = buildServices({
      taskService: { listWorkProducts: vi.fn(async () => [fakeWpListItem()]) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "list_work_products", { task_id: "task_1" });
    expect((result.content.work_products as unknown[])[0]).toMatchObject({
      url: null,
      summary: null,
    });
  });

  it("get_work_product nulls every absent optional field", async () => {
    const services = buildServices({
      taskService: { getWorkProduct: vi.fn(async () => fakeWp()) },
    });
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    const result = await callTool(tools, "get_work_product", { id: "wp_1" });
    expect(result.content.work_product).toMatchObject({
      summary: null,
      body: null,
      url: null,
      provider: null,
      external_id: null,
      metadata: null,
    });
  });
});

// ── create_task optional passthrough ─────────────────────────────────────

describe("create_task optional fields", () => {
  function subordinateServices() {
    return buildServices({
      agentRepo: {
        findSubordinates: vi.fn(async () => [fakeAgent({ id: "sub_1" })]),
      },
    });
  }

  it("forwards description, parent_task_id, repo_url and priority", async () => {
    const services = subordinateServices();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team", sessionId: "sess_team" },
      services,
    );

    await callTool(tools, "create_task", {
      intent: "do it",
      agent_id: "sub_1",
      description: "the long form",
      parent_task_id: "task_parent",
      repo_url: "https://github.com/acme/app",
      priority: "high",
    });

    expect(vi.mocked(services.taskRepo.create).mock.calls[0]?.[0]).toMatchObject({
      title: "do it",
      description: "the long form",
      parent_task_id: "task_parent",
      repo_url: "https://github.com/acme/app",
      priority: "high",
      status: "assigned",
      assignee_id: "sub_1",
      creator_id: "agent_t",
      creator_type: "agent",
    });
    // Nesting the IC transcript under the team session is what makes the
    // chat UI able to show the spawned work inline.
    expect(
      vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]?.[0],
    ).toMatchObject({ parentSessionId: "sess_team" });
  });

  it.each([
    ["non-string", 1],
    ["an empty string", ""],
  ])("drops a %s repo_url", async (_label, repo_url) => {
    const services = subordinateServices();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    await callTool(tools, "create_task", {
      intent: "do it",
      agent_id: "sub_1",
      repo_url,
    });

    expect(
      vi.mocked(services.taskRepo.create).mock.calls[0]?.[0].repo_url,
    ).toBeUndefined();
  });

  it("drops non-string description and parent_task_id, and defaults priority", async () => {
    const services = subordinateServices();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    await callTool(tools, "create_task", {
      intent: "do it",
      agent_id: "sub_1",
      description: 1,
      parent_task_id: {},
    });

    const created = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0];
    expect(created?.description).toBeUndefined();
    expect(created?.parent_task_id).toBeUndefined();
    expect(created?.priority).toBe("medium");
  });

  it("leaves parentSessionId undefined for callers outside a session", async () => {
    const services = subordinateServices();
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    await callTool(tools, "create_task", { intent: "do it", agent_id: "sub_1" });

    expect(
      vi.mocked(services.dispatchService.dispatchTask).mock.calls[0]?.[0]
        .parentSessionId,
    ).toBeUndefined();
  });
});

// ── create_work_product / update_work_product optional passthrough ───────

describe("work-product optional fields", () => {
  const OPTIONALS = {
    summary: "a summary",
    body: "a body",
    url: "https://github.com/acme/app/pull/1",
    provider: "github",
    external_id: "1",
    metadata: { additions: 12 },
  };

  it("create_work_product forwards every optional field", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "create_work_product", {
      task_id: "task_1",
      type: "pull_request",
      title: "t",
      ...OPTIONALS,
    });

    expect(
      vi.mocked(services.taskService.createWorkProduct).mock.calls[0]?.[0],
    ).toMatchObject(OPTIONALS);
  });

  it.each([
    ["create_work_product", { task_id: "task_1", type: "pull_request", title: "t" }],
    ["update_work_product", { id: "wp_1" }],
  ])("%s drops non-string optionals and non-object metadata", async (name, base) => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    await callTool(tools, name, {
      ...base,
      summary: 1,
      body: [],
      url: {},
      provider: null,
      external_id: 7,
      metadata: "additions=12",
    });

    const patch =
      name === "create_work_product"
        ? vi.mocked(services.taskService.createWorkProduct).mock.calls[0]?.[0]
        : vi.mocked(services.taskService.updateWorkProduct).mock.calls[0]?.[1];
    expect(patch).toMatchObject({
      summary: undefined,
      url: undefined,
      provider: undefined,
      external_id: undefined,
      metadata: undefined,
    });
  });

  it("update_work_product forwards every optional field", async () => {
    const services = buildServices();
    const tools = buildHierarchyTools({ agentId: "a", hierarchyLevel: "ic" }, services);

    await callTool(tools, "update_work_product", { id: "wp_1", ...OPTIONALS });

    expect(
      vi.mocked(services.taskService.updateWorkProduct).mock.calls[0]?.[1],
    ).toMatchObject(OPTIONALS);
  });
});

// ── Thrown-error envelopes ───────────────────────────────────────────────

/**
 * Each handler wraps its body in a try/catch that funnels to
 * `toolErrorFromThrown`. Without the catch, a repo throw escapes into the
 * MCP server and the agent sees a protocol-level failure instead of a
 * result it can reason about — so every tool's catch is driven here.
 */
describe("thrown-error envelopes", () => {
  const BOOM = new Error("connection terminated");
  const reject = () => vi.fn(async () => { throw BOOM; });

  const CASES: Array<[
    tool: string,
    input: Record<string, unknown>,
    overrides: Parameters<typeof buildServices>[0],
  ]> = [
    ["search_context", { query: "auth" }, { memoryAgent: { searchArchival: reject() } }],
    ["update_progress", { task_id: "t1", status: "done", summary: "s" }, { taskService: { updateProgress: reject() } }],
    ["find_up", {}, { agentRepo: { findParent: reject() } }],
    ["get_agent_profile", { agent_id: "agent_a" }, { agentRepo: { findById: reject() } }],
    ["get_task", { task_id: "task_1" }, { taskRepo: { findById: reject() } }],
    ["create_work_product", { task_id: "t1", type: "pull_request", title: "t" }, { taskService: { createWorkProduct: reject() } }],
    ["list_work_products", { task_id: "t1" }, { taskService: { listWorkProducts: reject() } }],
    ["get_work_product", { id: "wp_1" }, { taskService: { getWorkProduct: reject() } }],
    ["update_work_product", { id: "wp_1" }, { taskService: { updateWorkProduct: reject() } }],
    ["find_subordinates", {}, { agentRepo: { findSubordinates: reject() } }],
    ["find_peers", {}, { agentRepo: { findPeers: reject() } }],
    ["create_task", { intent: "do it", agent_id: "sub_1" }, { agentRepo: { findSubordinates: reject() } }],
    ["check_work_status", { agent_id: "agent_t" }, { taskRepo: { listByAssignee: reject() } }],
  ];

  it.each(CASES)("%s envelopes a repo throw", async (name, input, overrides) => {
    const services = buildServices(overrides);
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, name, input);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual({ error: "connection terminated" });
  });
});
