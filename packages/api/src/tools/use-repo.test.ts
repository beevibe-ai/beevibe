/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is a four-step sequence with a validation gate in front:
 * validate goal + repo_url, resolve the calling agent, create the
 * container task, dispatch the sandbox session, then insert the
 * repo_run row. Order matters — `repo_run.session_id` FKs to
 * `session.id`, so the dispatch has to land first. These tests pin that
 * ordering explicitly, because a future refactor that swaps the two
 * calls would still pass every per-step assertion.
 *
 * The two failure paths after the task insert (dispatch throws,
 * repo_run insert throws) each leave a different amount of debris
 * behind, and the tool reports a distinct code for each so the agent
 * can tell "nothing started" from "started but orphaned". Both are
 * covered below.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

const AGENT = "agent_ic";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Scout",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function makeServices(overrides: Record<string, unknown> = {}) {
  const agentRepo = { findById: vi.fn().mockResolvedValue(fakeAgent()) };
  // The real repo echoes the row back with its generated columns filled
  // in; the tool only reads `.id`, which it minted itself.
  const taskRepo = { create: vi.fn().mockImplementation(async (t: Task) => t) };
  const repoRunRepo = { create: vi.fn().mockResolvedValue(undefined) };
  const dispatchService = {
    dispatchTask: vi.fn().mockResolvedValue({ session: { id: "sess_x" }, runtime_id: "rt_1" }),
  };
  return {
    agentRepo: agentRepo as unknown as AgentRepository,
    taskRepo: taskRepo as unknown as TaskRepository,
    repoRunRepo: repoRunRepo as unknown as RepoRunRepository,
    dispatchService: dispatchService as unknown as DispatchService,
    ...overrides,
    // Handles kept unwrapped for assertions.
    _agentRepo: agentRepo,
    _taskRepo: taskRepo,
    _repoRunRepo: repoRunRepo,
    _dispatch: dispatchService,
  };
}

function build(services = makeServices()) {
  const tool = createUseRepoTool({ agentId: AGENT }, services);
  return { tool, services };
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("createUseRepoTool", () => {
  it("exposes the use_repo name and requires goal + repo_url", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect((tool.schema as { required: string[] }).required).toEqual(["goal", "repo_url"]);
    expect((tool.schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });
});

describe("use_repo — input validation", () => {
  it.each([
    ["missing goal", { repo_url: GOOD.repo_url }],
    ["blank goal", { goal: "   ", repo_url: GOOD.repo_url }],
    ["non-string goal", { goal: 12, repo_url: GOOD.repo_url }],
  ])("rejects %s with invalid_goal", async (_label, input) => {
    const { tool, services } = build();
    const res = await tool.handler(input);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(services._agentRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["missing repo_url", {}],
    ["a non-GitHub host", { repo_url: "https://gitlab.com/acme/tool" }],
    ["plain http", { repo_url: "http://github.com/acme/tool" }],
    ["a lookalike host", { repo_url: "https://notgithub.com/acme/tool" }],
    ["an unparseable string", { repo_url: "not a url" }],
    ["a non-string", { repo_url: 42 }],
  ])("rejects %s with invalid_repo_url", async (_label, extra) => {
    const { tool, services } = build();
    const res = await tool.handler({ goal: GOOD.goal, ...extra });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(services._taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "https://GITHUB.COM/acme/tool",
  ])("accepts %s", async (repo_url) => {
    const { tool } = build();
    const res = await tool.handler({ goal: GOOD.goal, repo_url });
    expect(res.isError).toBeUndefined();
  });

  it("404s when the calling agent row is gone", async () => {
    const services = makeServices();
    services._agentRepo.findById.mockResolvedValue(undefined);
    const { tool } = build(services);

    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(services._taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo — happy path", () => {
  it("creates the container task pinned to the calling agent", async () => {
    const { tool, services } = build();
    await tool.handler(GOOD);

    const task = services._taskRepo.create.mock.calls[0]![0];
    expect(task).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
    });
    expect(task.id).toMatch(/^task_/);
  });

  it("truncates a long goal into an 80-char container task title", async () => {
    const { tool, services } = build();
    const goal = "x".repeat(200);
    await tool.handler({ ...GOOD, goal });

    const { title, description } = services._taskRepo.create.mock.calls[0]![0];
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The full goal still reaches the child agent via description.
    expect(description).toBe(goal);
  });

  it("collapses whitespace in the title but not the dispatched goal", async () => {
    const { tool, services } = build();
    await tool.handler({ ...GOOD, goal: "  extract\n\n  the   tables  " });

    expect(services._taskRepo.create.mock.calls[0]![0].title).toBe("extract the tables");
    expect(services._dispatch.dispatchTask.mock.calls[0]![0].intent).toBe(
      "extract\n\n  the   tables",
    );
  });

  it("dispatches a run_repo session under a pre-minted session id", async () => {
    const { tool, services } = build();
    const res = await tool.handler(GOOD);

    const dispatched = services._dispatch.dispatchTask.mock.calls[0]![0];
    expect(dispatched).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    // The container task built one step earlier is handed to the
    // dispatch verbatim, so the sandbox session hangs off the same row
    // the work_product will later land on.
    expect(dispatched.task).toBe(services._taskRepo.create.mock.calls[0]![0]);
    // The tool mints the session id itself so repo_run can reference it;
    // the response has to echo the same one back.
    expect(dispatched.sessionIdOverride).toBe(res.content.session_id);
  });

  it("inserts the repo_run AFTER the dispatch — repo_run.session_id FKs to session.id", async () => {
    const order: string[] = [];
    const services = makeServices();
    services._dispatch.dispatchTask.mockImplementation(async () => {
      order.push("dispatch");
      return { session: { id: "sess_x" }, runtime_id: "rt_1" };
    });
    services._repoRunRepo.create.mockImplementation(async () => {
      order.push("repo_run");
    });
    const { tool } = build(services);

    await tool.handler(GOOD);
    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("writes a pending repo_run tying session, task and repo together", async () => {
    const { tool, services } = build();
    const res = await tool.handler(GOOD);

    expect(services._repoRunRepo.create).toHaveBeenCalledWith({
      id: res.content.repo_run_id,
      session_id: res.content.session_id,
      task_id: services._taskRepo.create.mock.calls[0]![0].id,
      agent_id: AGENT,
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("returns the ids, the watch url and a poll hint", async () => {
    const { tool } = build();
    const res = await tool.handler(GOOD);

    expect(res.isError).toBeUndefined();
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toMatch(/^task_/);
    expect(res.content.status).toBe("pending");
    expect(res.content.watch_url).toBe(`/capabilities/runs/${res.content.repo_run_id}`);
    expect(res.content.note).toMatch(/poll/i);
  });

  it("trims and echoes input_url and input_filename", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.com/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves input_url and input_filename undefined when absent or non-string", async () => {
    const { tool } = build();
    const res = await tool.handler({ ...GOOD, input_url: 5 });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — limits parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const { tool } = build();
    const res = await tool.handler({ ...GOOD, limits });
    return res.content.limits as Record<string, unknown>;
  }

  it("passes through in-range values", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 1024 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 1024 });
  });

  it("clamps each value to its ceiling", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 999, max_install_attempts: 99, disk_mb: 999_999 }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors the integer-valued limits but not wall clock", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 2.5, max_install_attempts: 2.9, disk_mb: 512.7 }),
    ).toEqual({ wall_clock_minutes: 2.5, max_install_attempts: 2, disk_mb: 512 });
  });

  it.each([
    ["zero", { wall_clock_minutes: 0, max_install_attempts: 0, disk_mb: 0 }],
    ["negative", { wall_clock_minutes: -1, max_install_attempts: -1, disk_mb: -1 }],
    ["non-numeric", { wall_clock_minutes: "10", max_install_attempts: null, disk_mb: [] }],
  ])("drops %s values so the sandbox default applies", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a non-object", "20m"],
  ])("returns {} when limits is %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });
});

describe("use_repo — failure after the task insert", () => {
  it("reports dispatch_failed and never inserts the repo_run", async () => {
    const services = makeServices();
    services._dispatch.dispatchTask.mockRejectedValue(new Error("no runtime bound"));
    const { tool } = build(services);

    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(services._repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const services = makeServices();
    services._dispatch.dispatchTask.mockRejectedValue("kaboom");
    const { tool } = build(services);

    expect((await tool.handler(GOOD)).content).toEqual({
      error: "dispatch_failed",
      message: "kaboom",
    });
  });

  it("reports repo_run_create_failed — the session row is already orphaned", async () => {
    // The session landed but has no repo_run to compose a payload from.
    // composeDispatchPayload self-recovers by failing the session; the
    // agent still needs to hear about it rather than wait on a run that
    // will never start.
    const services = makeServices();
    services._repoRunRepo.create.mockRejectedValue(new Error("duplicate key"));
    const { tool } = build(services);

    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(services._dispatch.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const services = makeServices();
    services._repoRunRepo.create.mockRejectedValue({ code: "23505" });
    const { tool } = build(services);

    expect((await tool.handler(GOOD)).content).toMatchObject({
      error: "repo_run_create_failed",
    });
  });
});
