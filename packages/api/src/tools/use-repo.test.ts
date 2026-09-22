/**
 * use_repo handler tests.
 *
 * The handler is the Capability Network's front door: it validates the
 * agent's input, mints the container task, then does two writes in a
 * strict order (dispatch creates the session row; repo_run's FK needs it
 * to exist first). Everything it depends on is injected, so the whole
 * surface — validation, limit clamping, write ordering, and the two
 * distinct failure envelopes — runs against fakes.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@beevibe/core";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    title: "t",
    status: "todo",
    priority: "medium",
    creator_id: "agent_1",
    creator_type: "agent",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Task;
}

interface Harness {
  tool: ReturnType<typeof createUseRepoTool>;
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  /** Write order, recorded so the FK-ordering contract can be asserted. */
  order: string[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const order: string[] = [];
  const findById =
    overrides.findById ?? vi.fn().mockResolvedValue({ id: "agent_1" });
  const createTask =
    overrides.createTask ??
    vi.fn(async (input: Task) => {
      order.push("task");
      return makeTask(input);
    });
  const dispatchTask =
    overrides.dispatchTask ??
    vi.fn(async () => {
      order.push("dispatch");
    });
  const createRepoRun =
    overrides.createRepoRun ??
    vi.fn(async () => {
      order.push("repo_run");
    });

  const services = {
    agentRepo: { findById },
    taskRepo: { create: createTask },
    repoRunRepo: { create: createRepoRun },
    dispatchService: { dispatchTask },
  } as unknown as UseRepoServices;

  return {
    tool: createUseRepoTool({ agentId: "agent_1" }, services),
    findById,
    createTask,
    createRepoRun,
    dispatchTask,
    order,
  };
}

const GOOD = { goal: "Extract tables", repo_url: "https://github.com/x/y" };

describe("use_repo — input validation", () => {
  it.each([
    ["missing", {}],
    ["blank", { goal: "   " }],
    ["not a string", { goal: 5 }],
  ])("rejects a goal that is %s", async (_label, extra) => {
    const h = harness();
    const res = await h.tool.handler({ repo_url: GOOD.repo_url, ...extra });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    // Nothing should be written when the input never validated.
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["not a URL at all", "not a url"],
    ["http, not https", "http://github.com/x/y"],
    ["a non-GitHub host", "https://gitlab.com/x/y"],
    // Suffix match must be anchored — an attacker-controlled host that
    // merely *ends in* the string "github.com" is not github.com.
    ["a lookalike host", "https://notgithub.com/x/y"],
    ["github.com as a path segment", "https://evil.test/github.com/x/y"],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const res = await h.tool.handler({
      goal: GOOD.goal,
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("accepts a github.com subdomain over https", async () => {
    const h = harness();
    const res = await h.tool.handler({
      goal: GOOD.goal,
      repo_url: "https://www.github.com/x/y",
    });

    expect(res.isError).toBeUndefined();
  });

  it("fails closed when the calling agent no longer exists", async () => {
    const h = harness({ findById: vi.fn().mockResolvedValue(null) });
    const res = await h.tool.handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(h.createTask).not.toHaveBeenCalled();
  });
});

describe("use_repo — happy path", () => {
  it("returns the freshly minted ids and a watch url built from the run id", async () => {
    const h = harness();
    const res = await h.tool.handler(GOOD);

    expect(res.isError).toBeUndefined();
    const c = res.content as Record<string, string>;
    expect(c.status).toBe("pending");
    expect(c.repo_run_id).toMatch(/\S/);
    expect(c.session_id).toMatch(/\S/);
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);
    expect(c.task_id).toBe(h.createTask.mock.calls[0]![0].id);
  });

  it("creates the session row before the repo_run that FKs to it", async () => {
    // repo_run.session_id has a FK to session.id, and dispatchTask is what
    // creates the session row. Reversing these two is a constraint
    // violation in production, so the order is part of the contract.
    const h = harness();
    await h.tool.handler(GOOD);

    expect(h.order).toEqual(["task", "dispatch", "repo_run"]);
  });

  it("dispatches a run_repo session pinned to the pre-minted session id", async () => {
    const h = harness();
    const res = await h.tool.handler(GOOD);

    const dispatch = h.dispatchTask.mock.calls[0]![0];
    expect(dispatch.type).toBe("run_repo");
    expect(dispatch.agentId).toBe("agent_1");
    expect(dispatch.intent).toBe(GOOD.goal);
    expect(dispatch.reason).toEqual({ kind: "fresh" });
    // The override is what lets the repo_run insert reference the session.
    expect(dispatch.sessionIdOverride).toBe(
      (res.content as Record<string, string>).session_id,
    );
  });

  it("pins the container task to the agent as both creator and assignee", async () => {
    const h = harness();
    await h.tool.handler(GOOD);

    const task = h.createTask.mock.calls[0]![0];
    expect(task).toMatchObject({
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_1",
      creator_id: "agent_1",
      creator_type: "agent",
    });
  });

  it("persists the run with the caller's goal and repo url, pending", async () => {
    const h = harness();
    const res = await h.tool.handler(GOOD);

    expect(h.createRepoRun.mock.calls[0]![0]).toMatchObject({
      id: (res.content as Record<string, string>).repo_run_id,
      session_id: (res.content as Record<string, string>).session_id,
      agent_id: "agent_1",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("trims surrounding whitespace off goal and repo_url", async () => {
    const h = harness();
    await h.tool.handler({
      goal: "  Extract tables  ",
      repo_url: "  https://github.com/x/y  ",
    });

    expect(h.createRepoRun.mock.calls[0]![0]).toMatchObject({
      goal: "Extract tables",
      repo_url: "https://github.com/x/y",
    });
  });

  it("echoes optional input_url and input_filename back to the agent", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...GOOD,
      input_url: " https://example.test/a.pdf ",
      input_filename: " a.pdf ",
    });

    expect(res.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves input fields undefined when they aren't strings", async () => {
    const h = harness();
    const res = await h.tool.handler({ ...GOOD, input_url: 1, input_filename: {} });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — container task title", () => {
  it("collapses whitespace so the inbox row stays scannable", async () => {
    const h = harness();
    await h.tool.handler({ ...GOOD, goal: "Extract\n\n  the   tables" });

    expect(h.createTask.mock.calls[0]![0].title).toBe("Extract the tables");
  });

  it("keeps a title of exactly 80 chars intact", async () => {
    const h = harness();
    const goal = "a".repeat(80);
    await h.tool.handler({ ...GOOD, goal });

    expect(h.createTask.mock.calls[0]![0].title).toBe(goal);
  });

  it("truncates past 80 chars to 77 plus an ellipsis", async () => {
    const h = harness();
    await h.tool.handler({ ...GOOD, goal: "a".repeat(81) });

    const title = h.createTask.mock.calls[0]![0].title;
    expect(title).toBe("a".repeat(77) + "…");
    expect(title).toHaveLength(78);
    // The full goal still reaches the child agent via description.
    expect(h.createTask.mock.calls[0]![0].description).toHaveLength(81);
  });
});

describe("use_repo — limits", () => {
  it("passes sane limits through untouched", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...GOOD,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 999_999,
      },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const h = harness();
    const res = await h.tool.handler({
      ...GOOD,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });

    expect(res.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "10"],
  ])("drops a %s limit so the sandbox default applies", async (_label, value) => {
    const h = harness();
    const res = await h.tool.handler({
      ...GOOD,
      limits: { wall_clock_minutes: value, max_install_attempts: value, disk_mb: value },
    });

    expect(res.content.limits).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["not an object", "fast"],
  ])("treats %s limits as empty", async (_label, limits) => {
    const h = harness();
    const res = await h.tool.handler({ ...GOOD, limits });

    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo — write failures", () => {
  it("reports a dispatch failure without attempting the repo_run insert", async () => {
    const h = harness({
      dispatchTask: vi.fn().mockRejectedValue(new Error("no daemon online")),
    });

    const res = await h.tool.handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("surfaces an orphaned session rather than letting the agent wait forever", async () => {
    // The session row landed but repo_run didn't. The run self-recovers
    // (composeDispatchPayload finds no repo_run and fails the session),
    // but the agent has to be told, or it polls a run that never exists.
    const h = harness({
      createRepoRun: vi.fn().mockRejectedValue(new Error("fk violation")),
    });

    const res = await h.tool.handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error throw on both write paths", async () => {
    const dispatchThrow = harness({
      dispatchTask: vi.fn().mockRejectedValue("boom"),
    });
    expect((await dispatchThrow.tool.handler(GOOD)).content.message).toBe("boom");

    const repoRunThrow = harness({
      createRepoRun: vi.fn().mockRejectedValue("splat"),
    });
    expect((await repoRunThrow.tool.handler(GOOD)).content.message).toBe("splat");
  });
});
