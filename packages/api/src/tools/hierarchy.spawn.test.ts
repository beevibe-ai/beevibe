/**
 * Tests for the three hierarchy handlers `hierarchy.test.ts` leaves
 * untouched: revise_task, add_to_escalation, and
 * create_subordinate_agent.
 *
 * These are the team-tier delegation surface's write paths, and the
 * three longest handlers in the module. They're separated into their own
 * file because each needs a richer fake graph than the shared harness
 * next door provides — create_subordinate_agent alone drives
 * provisionAgent (real code, fake repos), five core-memory seed writes,
 * a daily-cap query and a best-effort audit row.
 *
 * No DB: every repo and service is a fake.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentProvisionEventRepository,
  AgentRepository,
  CoreMemoryBlockRepository,
  Escalation,
  Session,
  Task,
  TaskRepository,
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

/** Matches the module-private SUBORDINATE_DAILY_CAP. */
const DAILY_CAP = 8;

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_a",
    name: "Team lead",
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
    status: "blocked",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Overrides {
  agentRepo?: Record<string, unknown>;
  taskRepo?: Record<string, unknown>;
  taskService?: Record<string, unknown>;
  escalationService?: Record<string, unknown>;
  dispatchService?: Record<string, unknown>;
  coreMemoryRepo?: Record<string, unknown>;
  agentProvisionEventRepo?: Record<string, unknown>;
  pool?: Record<string, unknown>;
}

function buildServices(o: Overrides = {}) {
  const seedWrites: Array<[string, string, string]> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const createdAgents: Array<Record<string, unknown>> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const notifies: Array<unknown[]> = [];

  const agentRepo = {
    findById: vi.fn(async () => undefined),
    findParent: vi.fn(async () => undefined),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    create: vi.fn(async (input: Record<string, unknown>) => {
      createdAgents.push(input);
      return fakeAgent(input as Partial<Agent>);
    }),
    ...o.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    findById: vi.fn(async () => undefined),
    listByAssignee: vi.fn(async () => []),
    create: vi.fn(async (input: Record<string, unknown>) =>
      fakeTask(input as Partial<Task>),
    ),
    ...o.taskRepo,
  } as unknown as TaskRepository;

  const taskService = {
    updateProgress: vi.fn(async () => fakeTask({ status: "done" })),
    reviseTask: vi.fn(async () =>
      fakeTask({ status: "needs_revision", assignee_id: "agent_sub" }),
    ),
    createWorkProduct: vi.fn(),
    listWorkProducts: vi.fn(async () => []),
    getWorkProduct: vi.fn(async () => undefined),
    updateWorkProduct: vi.fn(),
    ...o.taskService,
  } as unknown as TaskService;

  const escalationService = {
    create: vi.fn(),
    addContribution: vi.fn(async () => ({
      id: "esc_1",
      status: "pending",
    })),
    resolve: vi.fn(),
    ...o.escalationService,
  } as unknown as EscalationService;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      dispatched.push(input);
      return {
        session: {
          id: "sess_test",
          agent_id: input.agentId,
          type: "task",
          status: "pending",
          intent: "x",
          created_at: new Date(),
        } as Session,
        runtime_id: null,
      };
    }),
    ...o.dispatchService,
  } as unknown as DispatchService;

  const pool = {
    query: vi.fn(async (...args: unknown[]) => {
      notifies.push(args);
      return { rows: [] };
    }),
    ...o.pool,
  } as unknown as Pool;

  const coreMemoryRepo = {
    findByAgent: vi.fn(async () => []),
    initDefaults: vi.fn(async () => []),
    updateContent: vi.fn(
      async (agentId: string, block: string, content: string) => {
        seedWrites.push([agentId, block, content]);
        return undefined;
      },
    ),
    ...o.coreMemoryRepo,
  } as unknown as CoreMemoryBlockRepository;

  const agentProvisionEventRepo = {
    countByParentSince: vi.fn(async () => 0),
    create: vi.fn(async (row: Record<string, unknown>) => {
      auditRows.push(row);
      return row;
    }),
    listByParent: vi.fn(async () => []),
    ...o.agentProvisionEventRepo,
  } as unknown as AgentProvisionEventRepository;

  const memoryAgent = {
    prepareBriefing: vi.fn(async () => ({
      systemPromptAppend: "",
      userMessagePrefix: "",
      snapshot: {
        block_count: 0,
        fact_count: 0,
        token_count: 0,
        blocks: [],
        facts: [],
      },
    })),
    onTaskComplete: vi.fn(async () => {}),
  } as unknown as MemoryAgent;

  const services = {
    agentRepo,
    taskRepo,
    workProductRepo: {} as unknown as WorkProductRepository,
    taskService,
    memoryAgent,
    escalationService,
    dispatchService,
    pool,
    coreMemoryRepo,
    agentProvisionEventRepo,
  };

  return {
    services,
    seedWrites,
    auditRows,
    createdAgents,
    dispatched,
    notifies,
  };
}

function toolsFor(
  services: ReturnType<typeof buildServices>["services"],
  level: Agent["hierarchy_level"] = "team",
  agentId = "agent_a",
): AgentTool[] {
  return buildHierarchyTools(
    { agentId, hierarchyLevel: level, sessionId: "sess_caller" },
    services,
  );
}

function call(
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown> = {},
): Promise<AgentToolResult> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t.handler(input);
}

// ── revise_task ─────────────────────────────────────────────────────────

describe("revise_task", () => {
  /** Caller agent_a is the parent of the assignee agent_sub. */
  function parentOfAssignee(extra: Overrides = {}) {
    return buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ status: "blocked", assignee_id: "agent_sub" }),
        ),
      },
      agentRepo: {
        findById: vi.fn(async (id: string) =>
          id === "agent_sub"
            ? fakeAgent({
                id: "agent_sub",
                hierarchy_level: "ic",
                parent_agent_id: "agent_a",
              })
            : fakeAgent(),
        ),
      },
      ...extra,
    });
  }

  it("revises and reports both the new and the prior status", async () => {
    const h = parentOfAssignee();
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "use the staging key",
    });

    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual({
      revised: true,
      task_id: "task_1",
      status: "needs_revision",
      from_status: "blocked",
    });
  });

  it("stamps the revision source and reviser on the service call", async () => {
    const h = parentOfAssignee();
    await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "use the staging key",
    });

    expect(h.services.taskService.reviseTask).toHaveBeenCalledWith(
      "task_1",
      "use the staging key",
      { source: "parent_agent", reviserAgentId: "agent_a" },
    );
  });

  it("dispatches the revision session when reviseTask stamped a revision context", async () => {
    const next_dispatch_context = {
      kind: "revision" as const,
      feedback: "use the staging key",
      source: "parent_agent" as const,
      from_status: "blocked" as const,
      reviser_agent_id: "agent_a",
    };
    const h = parentOfAssignee({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            status: "needs_revision",
            assignee_id: "agent_sub",
            next_dispatch_context,
          }),
        ),
      },
    });

    await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "use the staging key",
    });

    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      agentId: "agent_sub",
      type: "task",
      reason: next_dispatch_context,
    });
    // The intent has to carry the feedback, or the resumed session has no
    // guidance to act on.
    expect(String(h.dispatched[0]?.intent)).toContain("use the staging key");
  });

  it("skips the dispatch when no revision context was stamped", async () => {
    const h = parentOfAssignee();
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(h.dispatched).toHaveLength(0);
    expect(out.isError).toBeUndefined();
  });

  it("skips the dispatch for a non-revision context kind", async () => {
    const h = parentOfAssignee({
      taskService: {
        reviseTask: vi.fn(async () =>
          fakeTask({
            status: "needs_revision",
            assignee_id: "agent_sub",
            next_dispatch_context: {
              kind: "post_escalation",
            } as unknown as Task["next_dispatch_context"],
          }),
        ),
      },
    });

    await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(h.dispatched).toHaveLength(0);
  });

  it.each([
    ["no task_id", { feedback: "f" }],
    ["no feedback", { task_id: "task_1" }],
    ["an empty feedback", { task_id: "task_1", feedback: "" }],
  ])("refuses %s before touching the repos", async (_label, input) => {
    const h = parentOfAssignee();
    const out = await call(toolsFor(h.services), "revise_task", input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "task_id and feedback required" });
    expect(h.services.taskRepo.findById).not.toHaveBeenCalled();
  });

  it("reports task_not_found with the id it was given", async () => {
    const h = buildServices();
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_gone",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "task_not_found",
      task_id: "task_gone",
    });
  });

  it("refuses an unassigned task", async () => {
    const h = buildServices({
      taskRepo: {
        findById: vi.fn(async () =>
          fakeTask({ assignee_id: undefined, status: "blocked" }),
        ),
      },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "task_unassigned",
      message: "task has no assignee",
    });
  });

  it("refuses when the assignee record is missing", async () => {
    const h = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ assignee_id: "agent_ghost" })),
      },
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "assignee_not_found" });
  });

  it("refuses a caller who is not the assignee's direct parent", async () => {
    const h = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ assignee_id: "agent_sub" })),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_sub", parent_agent_id: "agent_other" }),
        ),
      },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content.error).toBe("not_parent");
    expect(String(out.content.message)).toContain("agent_a");
    expect(h.services.taskService.reviseTask).not.toHaveBeenCalled();
  });

  it("refuses a grandparent — direct parent only", async () => {
    const h = buildServices({
      taskRepo: {
        findById: vi.fn(async () => fakeTask({ assignee_id: "agent_grandchild" })),
      },
      agentRepo: {
        findById: vi.fn(async () =>
          fakeAgent({ id: "agent_grandchild", parent_agent_id: "agent_mid" }),
        ),
      },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.content.error).toBe("not_parent");
  });

  it("maps InvalidTaskTransitionError onto invalid_transition", async () => {
    const h = parentOfAssignee({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new InvalidTaskTransitionError(
            "cannot revise a task in status done",
          );
        }),
      },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "invalid_transition",
      message: "cannot revise a task in status done",
    });
  });

  it("falls back to the catch-all envelope for any other throw", async () => {
    const h = parentOfAssignee({
      taskService: {
        reviseTask: vi.fn(async () => {
          throw new Error("pool exhausted");
        }),
      },
    });
    const out = await call(toolsFor(h.services), "revise_task", {
      task_id: "task_1",
      feedback: "f",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "pool exhausted" });
  });
});

// ── add_to_escalation ───────────────────────────────────────────────────

describe("add_to_escalation", () => {
  const esc = (overrides: Record<string, unknown> = {}) =>
    ({ id: "esc_1", status: "pending", ...overrides }) as unknown as Escalation;

  it("forwards the caller's contribution and reports the escalation state", async () => {
    const h = buildServices();
    const out = await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: [{ title: "B", description: "do B" }],
      open_questions: ["what is the SLA?"],
    });

    expect(h.services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_a",
      proposals: [{ title: "B", description: "do B" }],
      openQuestions: ["what is the SLA?"],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toEqual({
      escalation_id: "esc_1",
      status: "pending",
      both_sides_submitted: false,
    });
  });

  it("pg_notifies escalation_updated with the escalation id", async () => {
    const h = buildServices();
    await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    const [sql, params] = h.notifies[0] ?? [];
    expect(String(sql)).toContain("pg_notify('escalation_updated', $1)");
    expect(params).toEqual(["esc_1"]);
  });

  it("flags both_sides_submitted once both timestamps are set", async () => {
    const h = buildServices({
      escalationService: {
        addContribution: vi.fn(async () =>
          esc({
            status: "ready_for_human",
            initiator_submitted_at: new Date("2026-04-01"),
            counterparty_submitted_at: new Date("2026-04-02"),
          }),
        ),
      },
    });
    const out = await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(out.content).toEqual({
      escalation_id: "esc_1",
      status: "ready_for_human",
      both_sides_submitted: true,
    });
  });

  it.each([
    [
      "only the initiator submitted",
      { initiator_submitted_at: new Date("2026-04-01") },
    ],
    [
      "only the counterparty submitted",
      { counterparty_submitted_at: new Date("2026-04-01") },
    ],
  ])("leaves both_sides_submitted false when %s", async (_label, fields) => {
    const h = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => esc(fields)),
      },
    });
    const out = await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(out.content.both_sides_submitted).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["empty", { escalation_id: "" }],
  ])("refuses an %s escalation_id", async (_label, input) => {
    const h = buildServices();
    const out = await call(toolsFor(h.services), "add_to_escalation", input);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({ error: "escalation_id required" });
    expect(h.services.escalationService.addContribution).not.toHaveBeenCalled();
  });

  it("omits non-array proposals and open_questions", async () => {
    const h = buildServices();
    await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
      proposals: "just one",
      open_questions: { a: 1 },
    });

    expect(h.services.escalationService.addContribution).toHaveBeenCalledWith({
      escalationId: "esc_1",
      callerAgentId: "agent_a",
      proposals: undefined,
      openQuestions: undefined,
    });
  });

  it("keeps only the string open_questions", async () => {
    const h = buildServices();
    await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
      open_questions: ["real", 0, null, "also real"],
    });

    expect(h.services.escalationService.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({ openQuestions: ["real", "also real"] }),
    );
  });

  it("surfaces a double-submit refusal from the service", async () => {
    const h = buildServices({
      escalationService: {
        addContribution: vi.fn(async () => {
          throw new Error("agent_a already submitted to esc_1");
        }),
      },
    });
    const out = await call(toolsFor(h.services), "add_to_escalation", {
      escalation_id: "esc_1",
    });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "agent_a already submitted to esc_1",
    });
    expect(h.notifies).toHaveLength(0);
  });
});

// ── create_subordinate_agent ────────────────────────────────────────────

describe("create_subordinate_agent", () => {
  const VALID = {
    name: "Backend specialist",
    tag_line: "Owns the API surface",
    persona: "Pragmatic, test-first",
    domain: "Express routes and Postgres adapters",
  };

  function withParent(parent: Partial<Agent> = {}, extra: Overrides = {}) {
    return buildServices({
      agentRepo: {
        findById: vi.fn(async () => fakeAgent(parent)),
      },
      ...extra,
    });
  }

  describe("tool shape", () => {
    it("requires the four identity fields", () => {
      const h = buildServices();
      const t = toolsFor(h.services).find(
        (x) => x.name === "create_subordinate_agent",
      );
      expect(t?.schema.required).toEqual([
        "name",
        "tag_line",
        "persona",
        "domain",
      ]);
    });

    it("sources field guidance from the IC block templates", () => {
      // The point of the icBlocks map: the tool's per-field descriptions
      // and the agent-facing <core_memory> block descriptions stay in
      // lockstep because they're the same strings.
      const h = buildServices();
      const t = toolsFor(h.services).find(
        (x) => x.name === "create_subordinate_agent",
      );
      const props = t?.schema.properties as Record<
        string,
        { description?: string }
      >;
      const templates = new Map(
        DEFAULT_BLOCK_TEMPLATES.ic.map((x) => [x.block_name, x.description]),
      );

      for (const block of [
        "tag_line",
        "persona",
        "domain",
        "active_context",
        "constraints",
      ]) {
        expect(props[block]?.description).toBe(templates.get(block));
      }
    });
  });

  describe("tier gate", () => {
    it("is not in an IC caller's tool set at all", async () => {
      // The real gate is assembly-time: buildHierarchyTools gives the IC
      // tier the shared set only. The handler's own `ic_cannot_spawn`
      // branch is therefore belt-and-braces — unreachable through the
      // public builder, and kept for a future direct caller. Asserting
      // the absence is the honest test; see the branch note below.
      const h = withParent();
      const names = toolsFor(h.services, "ic").map((t) => t.name);

      expect(names).not.toContain("create_subordinate_agent");
    });

    it.each(["team", "org"] as const)("lets a %s caller spawn", async (level) => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services, level),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBeUndefined();
      expect(h.createdAgents).toHaveLength(1);
    });
  });

  describe("happy path", () => {
    it("creates an IC child under the caller and returns its identity", async () => {
      const h = withParent({ id: "agent_lead", owner_id: "person_7" });
      const out = await call(
        toolsFor(h.services, "team", "agent_lead"),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBeUndefined();
      const created = out.content.created as Record<string, unknown>;
      expect(created).toMatchObject({
        name: "Backend specialist",
        hierarchy_level: "ic",
        parent_agent_id: "agent_lead",
      });
      expect(String(created.id)).toMatch(/^agent_/);
    });

    it("inherits owner and hierarchy from the parent, and mints an api key", async () => {
      const h = withParent({ id: "agent_lead", owner_id: "person_7" });
      await call(
        toolsFor(h.services, "team", "agent_lead"),
        "create_subordinate_agent",
        VALID,
      );

      expect(h.createdAgents[0]).toMatchObject({
        owner_id: "person_7",
        parent_agent_id: "agent_lead",
        hierarchy_level: "ic",
        review_policy: "auto_done",
      });
      expect(String(h.createdAgents[0]?.api_key)).toMatch(/^bv_a_/);
    });

    it("inherits the parent's runtime config but overrides the prompt addition", async () => {
      const h = withParent({
        runtime_config: {
          type: "claude",
          model: "sonnet",
          system_prompt_addition: "You are Team lead.",
        } as Agent["runtime_config"],
      });
      await call(toolsFor(h.services), "create_subordinate_agent", VALID);

      const cfg = h.createdAgents[0]?.runtime_config as Record<string, unknown>;
      expect(cfg.model).toBe("sonnet");
      // The child's prompt names the child, not the parent — and the
      // persona stays out of the system prompt (it lives in core memory).
      expect(cfg.system_prompt_addition).toBe("You are Backend specialist.");
      expect(cfg.system_prompt_addition).not.toContain("Pragmatic");
    });

    it("pins the child to the parent's runtime when the parent has one", async () => {
      const h = withParent({ preferred_runtime_id: "rt_1" });
      await call(toolsFor(h.services), "create_subordinate_agent", VALID);

      expect(h.createdAgents[0]?.preferred_runtime_id).toBe("rt_1");
    });

    it("omits preferred_runtime_id entirely when the parent has none", async () => {
      const h = withParent({ preferred_runtime_id: undefined });
      await call(toolsFor(h.services), "create_subordinate_agent", VALID);

      expect(h.createdAgents[0]).not.toHaveProperty("preferred_runtime_id");
    });

    it("initializes the IC's default memory blocks before seeding", async () => {
      const h = withParent();
      await call(toolsFor(h.services), "create_subordinate_agent", VALID);

      expect(h.services.coreMemoryRepo.initDefaults).toHaveBeenCalledWith(
        expect.stringMatching(/^agent_/),
        "ic",
      );
    });

    it("seeds the three mandatory blocks and no optional ones", async () => {
      const h = withParent();
      await call(toolsFor(h.services), "create_subordinate_agent", VALID);

      expect(h.seedWrites.map(([, block]) => block).sort()).toEqual([
        "domain",
        "persona",
        "tag_line",
      ]);
      expect(h.seedWrites.map(([, , content]) => content)).toEqual(
        expect.arrayContaining([
          "Owns the API surface",
          "Pragmatic, test-first",
          "Express routes and Postgres adapters",
        ]),
      );
    });

    it("seeds the optional blocks when the parent supplied them", async () => {
      const h = withParent();
      await call(toolsFor(h.services), "create_subordinate_agent", {
        ...VALID,
        active_context: "Migrating auth to JWT",
        constraints: "No breaking API changes",
      });

      const blocks = Object.fromEntries(
        h.seedWrites.map(([, block, content]) => [block, content]),
      );
      expect(blocks.active_context).toBe("Migrating auth to JWT");
      expect(blocks.constraints).toBe("No breaking API changes");
    });

    it.each([
      ["blank", "   "],
      ["absent", undefined],
    ])("skips an optional block that is %s", async (_label, value) => {
      const h = withParent();
      await call(toolsFor(h.services), "create_subordinate_agent", {
        ...VALID,
        active_context: value,
        constraints: value,
      });

      const names = h.seedWrites.map(([, block]) => block);
      expect(names).not.toContain("active_context");
      expect(names).not.toContain("constraints");
    });

    it("writes every seed against the new child's id", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      const childId = (out.content.created as { id: string }).id;
      for (const [agentId] of h.seedWrites) {
        expect(agentId).toBe(childId);
      }
    });

    it("trims every field before use", async () => {
      const h = withParent();
      await call(toolsFor(h.services), "create_subordinate_agent", {
        name: "  Backend specialist  ",
        tag_line: "  Owns the API  ",
        persona: "  Pragmatic  ",
        domain: "  Routes  ",
      });

      expect(h.createdAgents[0]?.name).toBe("Backend specialist");
      const blocks = Object.fromEntries(
        h.seedWrites.map(([, block, content]) => [block, content]),
      );
      expect(blocks).toEqual({
        tag_line: "Owns the API",
        persona: "Pragmatic",
        domain: "Routes",
      });
    });

    it("writes the audit row linking parent, child, and briefing", async () => {
      const h = withParent({ id: "agent_lead", owner_id: "person_7" });
      const out = await call(
        toolsFor(h.services, "team", "agent_lead"),
        "create_subordinate_agent",
        VALID,
      );

      const childId = (out.content.created as { id: string }).id;
      expect(h.auditRows).toHaveLength(1);
      expect(h.auditRows[0]).toMatchObject({
        parent_agent_id: "agent_lead",
        child_agent_id: childId,
        owner_person_id: "person_7",
        child_name: "Backend specialist",
        persona: "Pragmatic, test-first",
        domain: "Express routes and Postgres adapters",
      });
    });
  });

  describe("field validation", () => {
    it.each(["name", "tag_line", "persona", "domain"])(
      "refuses a missing %s",
      async (field) => {
        const h = withParent();
        const input = { ...VALID } as Record<string, unknown>;
        delete input[field];
        const out = await call(
          toolsFor(h.services),
          "create_subordinate_agent",
          input,
        );

        expect(out.isError).toBe(true);
        expect(out.content.error).toBe("missing_required_fields");
        expect(h.createdAgents).toHaveLength(0);
      },
    );

    it.each(["name", "tag_line", "persona", "domain"])(
      "refuses a whitespace-only %s",
      async (field) => {
        const h = withParent();
        const out = await call(
          toolsFor(h.services),
          "create_subordinate_agent",
          { ...VALID, [field]: "   " },
        );

        expect(out.content.error).toBe("missing_required_fields");
      },
    );

    it("accepts a 100-char tag_line", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, tag_line: "t".repeat(100) },
      );

      expect(out.isError).toBeUndefined();
    });

    it("refuses a 101-char tag_line and reports the actual length", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, tag_line: "t".repeat(101) },
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({
        error: "tag_line_too_long",
        message: "tag_line must be ≤100 chars",
        actual: 101,
      });
      expect(h.createdAgents).toHaveLength(0);
    });

    it("accepts an 80-char name", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, name: "n".repeat(80) },
      );

      expect(out.isError).toBeUndefined();
    });

    it("refuses an 81-char name", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, name: "n".repeat(81) },
      );

      expect(out.isError).toBe(true);
      expect(out.content.error).toBe("invalid_name");
    });

    it.each([
      ["a null byte", "Back\u0000end"],
      ["a newline", "Back\nend"],
      ["a tab", "Back\tend"],
      ["a DEL char", "Back\u007fend"],
    ])("refuses a name containing %s", async (_label, name) => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, name },
      );

      expect(out.isError).toBe(true);
      expect(out.content.error).toBe("invalid_name");
      expect(h.createdAgents).toHaveLength(0);
    });

    it("allows non-ASCII names", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        { ...VALID, name: "后端专家 — Backend" },
      );

      expect(out.isError).toBeUndefined();
      expect(h.createdAgents[0]?.name).toBe("后端专家 — Backend");
    });

    it("reports missing_required_fields for a wholly empty input", async () => {
      const h = withParent();
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        {},
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({
        error: "missing_required_fields",
        message: "name, tag_line, persona, and domain are all required",
      });
    });
  });

  describe("parent resolution and the daily cap", () => {
    it("reports parent_not_found with the caller id", async () => {
      const h = buildServices({
        agentRepo: { findById: vi.fn(async () => undefined) },
      });
      const out = await call(
        toolsFor(h.services, "team", "agent_ghost"),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({
        error: "parent_not_found",
        agent_id: "agent_ghost",
      });
    });

    it("counts the parent's spawns over a 24h window", async () => {
      const h = withParent({ id: "agent_lead" });
      await call(
        toolsFor(h.services, "team", "agent_lead"),
        "create_subordinate_agent",
        VALID,
      );

      expect(
        h.services.agentProvisionEventRepo.countByParentSince,
      ).toHaveBeenCalledWith("agent_lead", 86_400);
    });

    it(`allows the spawn at ${DAILY_CAP - 1} prior spawns`, async () => {
      const h = withParent(
        {},
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => DAILY_CAP - 1),
          },
        },
      );
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBeUndefined();
      expect(h.createdAgents).toHaveLength(1);
    });

    it(`refuses at the cap of ${DAILY_CAP} and reports cap + count`, async () => {
      const h = withParent(
        { name: "Team lead" },
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => DAILY_CAP),
          },
        },
      );
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBe(true);
      expect(out.content).toMatchObject({
        error: "subordinate_daily_cap",
        cap: DAILY_CAP,
        count: DAILY_CAP,
      });
      expect(String(out.content.message)).toContain("Team lead");
      expect(h.createdAgents).toHaveLength(0);
    });

    it("refuses above the cap too", async () => {
      const h = withParent(
        {},
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => DAILY_CAP + 5),
          },
        },
      );
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.content).toMatchObject({
        error: "subordinate_daily_cap",
        count: DAILY_CAP + 5,
      });
    });
  });

  describe("failure handling", () => {
    it("still succeeds when the audit row fails to write", async () => {
      // Documented behavior: the agent + memory are the user-visible
      // artifacts, so a failed audit insert must not fail the spawn.
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const h = withParent(
        {},
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => 0),
            create: vi.fn(async () => {
              throw new Error("audit table is read-only");
            }),
          },
        },
      );

      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBeUndefined();
      expect(out.content.created).toBeDefined();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("audit row failed"),
        "audit table is read-only",
      );
      consoleError.mockRestore();
    });

    it("logs a non-Error audit throw without stringifying it away", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const h = withParent(
        {},
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => 0),
            create: vi.fn(async () => {
              throw { code: "23505" };
            }),
          },
        },
      );

      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), {
        code: "23505",
      });
      consoleError.mockRestore();
    });

    it("fails the spawn when the agent row can't be created", async () => {
      const h = buildServices({
        agentRepo: {
          findById: vi.fn(async () => fakeAgent()),
          create: vi.fn(async () => {
            throw new Error("unique violation on name");
          }),
        },
      });
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({ error: "unique violation on name" });
      expect(h.seedWrites).toHaveLength(0);
    });

    it("fails the spawn when a memory seed write rejects", async () => {
      const h = withParent(
        {},
        {
          coreMemoryRepo: {
            initDefaults: vi.fn(async () => []),
            updateContent: vi.fn(async () => {
              throw new Error("block char_limit exceeded");
            }),
          },
        },
      );
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({ error: "block char_limit exceeded" });
      // The audit row is written after the seeds, so it never ran.
      expect(h.auditRows).toHaveLength(0);
    });

    it("fails the spawn when the cap query itself errors", async () => {
      const h = withParent(
        {},
        {
          agentProvisionEventRepo: {
            countByParentSince: vi.fn(async () => {
              throw new Error("connection terminated");
            }),
          },
        },
      );
      const out = await call(
        toolsFor(h.services),
        "create_subordinate_agent",
        VALID,
      );

      expect(out.isError).toBe(true);
      expect(out.content).toEqual({ error: "connection terminated" });
      expect(h.createdAgents).toHaveLength(0);
    });
  });
});
