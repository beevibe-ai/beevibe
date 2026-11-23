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
} = {}) {
  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    // provisionAgent (create_subordinate_agent) inserts through this.
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
    // provisionAgent creates the tier's blocks empty; the tool then
    // overwrites the identity-bearing ones via updateContent.
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
  /** A blocked task assigned to a real subordinate of `agent_t`. */
  function blockedSetup(
    opts: {
      assigneeParent?: string | undefined;
      task?: Partial<Task>;
      revised?: Partial<Task>;
      reviseImpl?: () => Promise<Task>;
    } = {},
  ) {
    const task = fakeTask({
      id: "task_1",
      status: "blocked",
      assignee_id: "sub_1",
      ...opts.task,
    });
    const revised = fakeTask({
      id: "task_1",
      status: "needs_revision",
      assignee_id: "sub_1",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the staging key",
        from_status: "blocked",
        source: "parent_agent",
      },
      ...opts.revised,
    } as Partial<Task>);

    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => task) },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({
            id: "sub_1",
            hierarchy_level: "ic",
            parent_agent_id:
              "assigneeParent" in opts ? opts.assigneeParent : "agent_t",
          }),
        ),
      },
      taskService: {
        reviseTask: vi.fn(opts.reviseImpl ?? (async () => revised)),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    return { services, tools, task, revised };
  }

  it("revises the task and dispatches the resumed session", async () => {
    const { services, tools } = blockedSetup();

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "use the staging key",
    });

    expect(result.isError).toBeFalsy();
    expect(services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the staging key",
      { source: "parent_agent", reviserAgentId: "agent_t" },
    );
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const dispatched = (
      services.dispatchService.dispatchTask as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls[0]![0];
    expect(dispatched).toMatchObject({
      agentId: "sub_1",
      type: "task",
      reason: { kind: "revision", feedback: "use the staging key" },
    });
    // The parent's feedback has to reach the resumed session's intent.
    expect(String(dispatched.intent)).toContain("use the staging key");
  });

  it("reports needs_revision plus the status it came from", async () => {
    const { tools } = blockedSetup();

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.content).toMatchObject({
      revised: true,
      task_id: "task_1",
      // Post-#186: stays at needs_revision until the daemon claims.
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("skips the dispatch when reviseTask stamped no revision context", async () => {
    const { services, tools } = blockedSetup({
      revised: { next_dispatch_context: undefined } as Partial<Task>,
    });

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBeFalsy();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("skips the dispatch when the stamped context is some other kind", async () => {
    const { services, tools } = blockedSetup({
      revised: {
        next_dispatch_context: { kind: "crash_recovery" },
      } as unknown as Partial<Task>,
    });

    await callTool(tools, "revise_task", { task_id: "task_1", feedback: "f" });

    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("requires both task_id and feedback", async () => {
    const { services, tools } = blockedSetup();

    for (const input of [{}, { task_id: "task_1" }, { feedback: "f" }]) {
      const result = await callTool(tools, "revise_task", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe(
        "task_id and feedback required",
      );
    }
    expect(services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("404s an unknown task", async () => {
    const services = buildServices({
      taskRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, "revise_task", {
      task_id: "nope",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "task_not_found",
      task_id: "nope",
    });
  });

  it("refuses a task with no assignee", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ status: "blocked", assignee_id: undefined }),
        ),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("task_unassigned");
  });

  it("refuses when the assignee row is gone", async () => {
    const services = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ status: "blocked", assignee_id: "sub_gone" }),
        ),
      },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe(
      "assignee_not_found",
    );
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const { services, tools } = blockedSetup({
      assigneeParent: "agent_someone_else",
    });

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "not_parent" });
    expect(services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a caller when the assignee has no parent at all", async () => {
    const { tools } = blockedSetup({ assigneeParent: undefined });

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect((result.content as { error: string }).error).toBe("not_parent");
  });

  it("maps InvalidTaskTransitionError to invalid_transition", async () => {
    const { tools } = blockedSetup({
      reviseImpl: async () => {
        throw new InvalidTaskTransitionError(
          "cannot revise a task in status done",
        );
      },
    });

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "invalid_transition",
      message: "cannot revise a task in status done",
    });
  });

  it("envelopes any other throw", async () => {
    const { tools } = blockedSetup({
      reviseImpl: async () => {
        throw new Error("pool exhausted");
      },
    });

    const result = await callTool(tools, "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "pool exhausted" });
  });
});

// ── add_to_escalation ────────────────────────────────────────────────────

describe("add_to_escalation", () => {
  function setup(
    addContribution?: () => Promise<unknown>,
  ): { services: ReturnType<typeof buildServices>; tools: AgentTool[] } {
    const services = buildServices({
      escalationService: {
        addContribution: vi.fn(
          (addContribution ??
            (async () => ({
              id: "esc_1",
              status: "pending",
              initiator_submitted_at: new Date("2026-04-01"),
              counterparty_submitted_at: undefined,
            }))) as never,
        ),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: "team" },
      services,
    );
    return { services, tools };
  }

  it("submits the caller's proposals and questions, then notifies listeners", async () => {
    const { services, tools } = setup();

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "B", description: "do B" }],
      open_questions: ["what is the budget?"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_t",
      proposals: [{ title: "B", description: "do B" }],
      openQuestions: ["what is the budget?"],
    });
    expect(services.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("pg_notify('escalation_updated'"),
      ["esc_1"],
    );
    expect(result.isError).toBeFalsy();
  });

  it("reports both_sides_submitted false while one slot is still empty", async () => {
    const { tools } = setup();

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.content).toMatchObject({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });
  });

  it("reports both_sides_submitted once each side has a timestamp", async () => {
    const { tools } = setup(async () => ({
      id: "esc_1",
      status: "ready_for_human",
      initiator_submitted_at: new Date("2026-04-01"),
      counterparty_submitted_at: new Date("2026-04-02"),
    }));

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.content).toMatchObject({
      status: "ready_for_human",
      both_sides_submitted: true,
    });
  });

  it("requires an escalation_id", async () => {
    const { services, tools } = setup();

    for (const input of [{}, { escalation_id: "" }]) {
      const result = await callTool(tools, "add_to_escalation", input);
      expect(result.isError).toBe(true);
      expect((result.content as { error: string }).error).toBe(
        "escalation_id required",
      );
    }
    expect(services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("omits proposals and open_questions that are not arrays", async () => {
    const { services, tools } = setup();

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "nope",
      open_questions: 42,
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        proposals: undefined,
        openQuestions: undefined,
      }),
    );
  });

  it("drops non-string open_questions entries", async () => {
    const { services, tools } = setup();

    await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real", 1, null, "also real"],
    });

    expect(services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real", "also real"] }),
    );
  });

  it("does not notify when the contribution is rejected", async () => {
    const { services, tools } = setup(async () => {
      throw new Error("already submitted for this slot");
    });

    const result = await callTool(tools, "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "already submitted for this slot",
    });
    expect(services.pool.query).not.toHaveBeenCalled();
  });
});

// ── create_subordinate_agent ─────────────────────────────────────────────

describe("create_subordinate_agent", () => {
  const GOOD_INPUT = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, test-first, allergic to premature abstraction.",
    domain: "packages/api — Express routes, MCP tool wiring",
  };

  function setup(
    opts: {
      parent?: Partial<Agent> | null;
      recentSpawns?: number;
      apeCreate?: () => Promise<unknown>;
      agentCreate?: (input: Partial<Agent>) => Promise<Agent>;
      level?: HierarchyLevel;
    } = {},
  ) {
    const parent =
      opts.parent === null
        ? undefined
        : fakeAgent({
            id: "agent_t",
            name: "Team lead",
            owner_id: "person_1",
            hierarchy_level: "team",
            runtime_config: { type: "claude", model: "opus" },
            ...opts.parent,
          });

    const services = buildServices({
      agentRepo: {
        findById: vi.fn(async () => parent),
        create: vi.fn(
          (opts.agentCreate ??
            (async (input: Partial<Agent>) => fakeAgent(input))) as never,
        ),
      },
      agentProvisionEventRepo: {
        countByParentSince: vi.fn(async () => opts.recentSpawns ?? 0),
        ...(opts.apeCreate ? { create: vi.fn(opts.apeCreate as never) } : {}),
      },
    });
    const tools = buildHierarchyTools(
      { agentId: "agent_t", hierarchyLevel: opts.level ?? "team" },
      services,
    );
    return { services, tools };
  }

  /** Reads the (agentId, blockName, content) triples written to core memory. */
  function seededBlocks(services: ReturnType<typeof buildServices>) {
    return (
      services.coreMemoryRepo.updateContent as unknown as {
        mock: { calls: Array<[string, string, string]> };
      }
    ).mock.calls.map(([, block, content]) => [block, content]);
  }

  it("creates an IC under the caller and reports the new id back", async () => {
    const { services, tools } = setup();

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    expect(result.isError).toBeFalsy();
    const created = (result.content as { created: Record<string, unknown> })
      .created;
    expect(created).toMatchObject({
      name: "Backend specialist",
      hierarchy_level: "ic",
      parent_agent_id: "agent_t",
    });
    expect(String(created.id)).toMatch(/^agent_/);
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("inherits the parent's owner and runtime but restamps the prompt addition", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", GOOD_INPUT);

    const row = (
      services.agentRepo.create as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls[0]![0];
    expect(row).toMatchObject({
      owner_id: "person_1",
      parent_agent_id: "agent_t",
      hierarchy_level: "ic",
    });
    expect(row.runtime_config).toMatchObject({
      type: "claude",
      model: "opus",
      // The persona lives in core memory, not the system prompt.
      system_prompt_addition: "You are Backend specialist.",
    });
  });

  it("pins the child to the parent's daemon when the parent has one", async () => {
    const { services, tools } = setup({
      parent: { preferred_runtime_id: "rt_1" },
    });

    await callTool(tools, "create_subordinate_agent", GOOD_INPUT);

    expect(
      (
        services.agentRepo.create as unknown as {
          mock: { calls: Array<[Record<string, unknown>]> };
        }
      ).mock.calls[0]![0],
    ).toMatchObject({ preferred_runtime_id: "rt_1" });
  });

  it("omits preferred_runtime_id entirely when the parent has none", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", GOOD_INPUT);

    const row = (
      services.agentRepo.create as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls[0]![0];
    expect(row).not.toHaveProperty("preferred_runtime_id");
  });

  it("seeds the three required identity blocks", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", GOOD_INPUT);

    expect(seededBlocks(services)).toEqual([
      ["tag_line", GOOD_INPUT.tag_line],
      ["persona", GOOD_INPUT.persona],
      ["domain", GOOD_INPUT.domain],
    ]);
  });

  it("seeds the optional blocks only when the parent supplied content", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", {
      ...GOOD_INPUT,
      active_context: "Migrating auth to the new middleware",
      constraints: "Never touch migrations/",
    });

    expect(seededBlocks(services)).toEqual([
      ["tag_line", GOOD_INPUT.tag_line],
      ["persona", GOOD_INPUT.persona],
      ["domain", GOOD_INPUT.domain],
      ["active_context", "Migrating auth to the new middleware"],
      ["constraints", "Never touch migrations/"],
    ]);
  });

  it("leaves whitespace-only optional blocks empty for the IC to fill in", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", {
      ...GOOD_INPUT,
      active_context: "   ",
      constraints: "",
    });

    expect(seededBlocks(services).map(([b]) => b)).toEqual([
      "tag_line",
      "persona",
      "domain",
    ]);
  });

  it("trims the supplied fields before persisting them", async () => {
    const { services, tools } = setup();

    await callTool(tools, "create_subordinate_agent", {
      name: "  Backend specialist  ",
      tag_line: "  Owns the API surface  ",
      persona: "  Pragmatic  ",
      domain: "  packages/api  ",
    });

    expect(seededBlocks(services)).toEqual([
      ["tag_line", "Owns the API surface"],
      ["persona", "Pragmatic"],
      ["domain", "packages/api"],
    ]);
  });

  it("writes an audit row linking parent to child", async () => {
    const { services, tools } = setup();

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );
    const childId = (result.content as { created: { id: string } }).created.id;

    expect(services.agentProvisionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_agent_id: "agent_t",
        child_agent_id: childId,
        owner_person_id: "person_1",
        child_name: "Backend specialist",
        persona: GOOD_INPUT.persona,
        domain: GOOD_INPUT.domain,
      }),
    );
  });

  it("still reports success when the audit row fails to write", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tools } = setup({
      apeCreate: async () => {
        throw new Error("audit table is read-only");
      },
    });

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    // The agent + its memory are the user-visible artifacts; a missing
    // audit row must not undo them.
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is absent from the IC tier, which cannot have subordinates", () => {
    // The handler also carries an `ic_cannot_spawn` guard, but it is
    // defence-in-depth only: buildHierarchyTools never hands the tool to
    // an IC in the first place, which is what this asserts.
    const icTools = buildHierarchyTools(
      { agentId: "agent_i", hierarchyLevel: "ic" },
      buildServices(),
    );
    expect(
      icTools.find((t) => t.name === "create_subordinate_agent"),
    ).toBeUndefined();
  });

  it("requires name, tag_line, persona and domain", async () => {
    for (const missing of ["name", "tag_line", "persona", "domain"]) {
      const { services, tools } = setup();
      const input = { ...GOOD_INPUT, [missing]: "   " };

      const result = await callTool(tools, "create_subordinate_agent", input);

      expect(result.isError, missing).toBe(true);
      expect(result.content, missing).toMatchObject({
        error: "missing_required_fields",
      });
      expect(services.agentRepo.create).not.toHaveBeenCalled();
    }
  });

  it("rejects a tag_line over 100 chars and reports the actual length", async () => {
    const { services, tools } = setup();

    const result = await callTool(tools, "create_subordinate_agent", {
      ...GOOD_INPUT,
      tag_line: "x".repeat(101),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "tag_line_too_long",
      actual: 101,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a tag_line of exactly 100 chars", async () => {
    const { tools } = setup();

    const result = await callTool(tools, "create_subordinate_agent", {
      ...GOOD_INPUT,
      tag_line: "x".repeat(100),
    });

    expect(result.isError).toBeFalsy();
  });

  it("rejects a name over 80 chars or carrying control characters", async () => {
    for (const name of ["n".repeat(81), "Back\u0000end", "Back\u001fend", "Back\u007fend"]) {
      const { services, tools } = setup();

      const result = await callTool(tools, "create_subordinate_agent", {
        ...GOOD_INPUT,
        name,
      });

      expect(result.isError, JSON.stringify(name)).toBe(true);
      expect(result.content, JSON.stringify(name)).toMatchObject({
        error: "invalid_name",
      });
      expect(services.agentRepo.create).not.toHaveBeenCalled();
    }
  });

  it("accepts a name of exactly 80 chars", async () => {
    const { tools } = setup();

    const result = await callTool(tools, "create_subordinate_agent", {
      ...GOOD_INPUT,
      name: "n".repeat(80),
    });

    expect(result.isError).toBeFalsy();
  });

  it("404s when the calling parent row is missing", async () => {
    const { services, tools } = setup({ parent: null });

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "parent_not_found",
      agent_id: "agent_t",
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
  });

  it("enforces the per-parent daily spawn cap", async () => {
    const { services, tools } = setup({ recentSpawns: 8 });

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "subordinate_daily_cap",
      cap: 8,
      count: 8,
    });
    expect(services.agentRepo.create).not.toHaveBeenCalled();
    // Counted over a rolling 24h window.
    expect(
      services.agentProvisionEventRepo.countByParentSince,
    ).toHaveBeenCalledWith("agent_t", 86_400);
  });

  it("allows the spawn one under the cap", async () => {
    const { services, tools } = setup({ recentSpawns: 7 });

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    expect(result.isError).toBeFalsy();
    expect(services.agentRepo.create).toHaveBeenCalledTimes(1);
  });

  it("envelopes a failure to insert the agent row", async () => {
    const { tools } = setup({
      agentCreate: async () => {
        throw new Error("duplicate key value violates unique constraint");
      },
    });

    const result = await callTool(
      tools,
      "create_subordinate_agent",
      GOOD_INPUT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "duplicate key value violates unique constraint",
    });
  });

  it("exposes per-field guidance drawn from the IC block templates", async () => {
    const { tools } = setup();
    const tool = findTool(tools, "create_subordinate_agent");
    const props = tool.schema.properties as Record<
      string,
      { description?: string }
    >;

    expect(tool.schema.required).toEqual([
      "name",
      "tag_line",
      "persona",
      "domain",
    ]);
    // Each core-memory-backed field carries the block's own description,
    // so the tool and the agent-facing <core_memory> stay in lockstep.
    for (const field of [
      "tag_line",
      "persona",
      "domain",
      "active_context",
      "constraints",
    ]) {
      expect(props[field]?.description, field).toBeTruthy();
    }
  });
});
