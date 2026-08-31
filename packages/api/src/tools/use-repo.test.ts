/**
 * use_repo handler tests.
 *
 * The handler is the ordering-sensitive part of the Capability Network
 * path: validate input, resolve the caller, create the container task,
 * dispatch (which creates the session row), then insert repo_run. The
 * comment in the module explains why that order is load-bearing —
 * repo_run.session_id has an FK to session.id — so the ordering is
 * asserted here rather than left to the integration path, which needs a
 * live Postgres and a spawned CLI.
 *
 * Everything downstream is stubbed; what's under test is the handler's
 * own validation, limit clamping and failure envelopes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import {
  createUseRepoTool,
  type UseRepoContext,
  type UseRepoServices,
} from "./use-repo.js";

const ctx: UseRepoContext = { agentId: "agent_1" };

const agent = { id: "agent_1", name: "Scout" };

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    title: "t",
    status: "todo",
    priority: "medium",
    creator_id: "agent_1",
    creator_type: "agent",
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as Task;
}

interface Harness {
  services: UseRepoServices;
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  /** Records the call order across the three collaborators. */
  order: string[];
}

function harness(
  opts: {
    agent?: unknown;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const order: string[] = [];

  const findById = vi.fn(async () => {
    order.push("agent.findById");
    return "agent" in opts ? opts.agent : agent;
  });
  const createTask = vi.fn(async (input: { id: string; title: string }) => {
    order.push("task.create");
    return makeTask({ id: input.id, title: input.title });
  });
  const dispatchTask = vi.fn(async () => {
    order.push("dispatch");
    if (opts.dispatchThrows) throw opts.dispatchThrows;
    return { session: {}, runtime_id: null };
  });
  const createRepoRun = vi.fn(async () => {
    order.push("repoRun.create");
    if (opts.repoRunThrows) throw opts.repoRunThrows;
    return {};
  });

  const services = {
    agentRepo: { findById } as unknown as AgentRepository,
    taskRepo: { create: createTask } as unknown as TaskRepository,
    repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  };

  return { services, findById, createTask, dispatchTask, createRepoRun, order };
}

function tool(h: Harness) {
  return createUseRepoTool(ctx, h.services);
}

const GOOD = { goal: "extract tables", repo_url: "https://github.com/o/r" };

describe("use_repo tool definition", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo happy path", () => {
  it("returns the minted ids, pending status and a watch url", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBeUndefined();
    const c = res.content as Record<string, string>;
    expect(c.status).toBe("pending");
    expect(c.repo_run_id).toMatch(/^rrn_|^repo_run_|.+/);
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);
    expect(c.task_id).toBeDefined();
    expect(c.session_id).toBeDefined();
  });

  // The FK on repo_run.session_id means the session row (created by
  // dispatchTask) must exist before the repo_run insert. If this order
  // ever flips, the insert violates the constraint in production.
  it("creates the task, dispatches, then inserts repo_run — in that order", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);
  });

  it("pins the container task to the resolved agent and carries the goal", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.createTask.mock.calls[0]![0]).toMatchObject({
      title: "extract tables",
      description: "extract tables",
      priority: "medium",
      assignee_id: "agent_1",
      creator_id: "agent_1",
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    const dispatched = h.dispatchTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      agentId: "agent_1",
      type: "run_repo",
      intent: "extract tables",
      reason: { kind: "fresh" },
      sessionIdOverride: (res.content as Record<string, string>).session_id,
    });
  });

  it("links the repo_run to the same session and task it dispatched", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    const c = res.content as Record<string, string>;

    expect(h.createRepoRun.mock.calls[0]![0]).toMatchObject({
      id: c.repo_run_id,
      session_id: c.session_id,
      task_id: c.task_id,
      agent_id: "agent_1",
      goal: "extract tables",
      repo_url: "https://github.com/o/r",
      status: "pending",
    });
  });

  it("trims goal and repo_url before using them", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "  extract tables  ",
      repo_url: "  https://github.com/o/r  ",
    });

    expect(h.createRepoRun.mock.calls[0]![0]).toMatchObject({
      goal: "extract tables",
      repo_url: "https://github.com/o/r",
    });
  });

  it("echoes input_url and input_filename back, trimmed", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      input_url: " https://x/y.pdf ",
      input_filename: " y.pdf ",
    });

    expect(res.content).toMatchObject({
      input_url: "https://x/y.pdf",
      input_filename: "y.pdf",
    });
  });
});

describe("container task title", () => {
  it("collapses whitespace", async () => {
    const h = harness();
    await tool(h).handler({ ...GOOD, goal: "extract\n\n  the   tables" });

    expect(h.createTask.mock.calls[0]![0].title).toBe("extract the tables");
  });

  // The title is an inbox row, so anything over 80 chars is cut to 77
  // plus an ellipsis — 78 in all. The description keeps the full goal.
  it("truncates a long goal to 77 chars plus an ellipsis, leaving description whole", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await tool(h).handler({ ...GOOD, goal });

    const created = h.createTask.mock.calls[0]![0];
    expect(created.title).toBe("x".repeat(77) + "…");
    expect(created.description).toBe(goal);
  });

  it("leaves a goal of exactly 80 chars untouched", async () => {
    const h = harness();
    await tool(h).handler({ ...GOOD, goal: "y".repeat(80) });

    expect(h.createTask.mock.calls[0]![0].title).toBe("y".repeat(80));
  });
});

describe("input validation", () => {
  it.each([
    ["missing", {}],
    ["blank", { goal: "   " }],
    ["non-string", { goal: 5 }],
  ])("rejects a %s goal before touching any collaborator", async (_l, over) => {
    const h = harness();
    const res = await tool(h).handler({ repo_url: GOOD.repo_url, ...over });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(h.findById).not.toHaveBeenCalled();
  });

  // Sandbox runs clone whatever URL they're handed, so the host allowlist
  // and the https requirement are a security boundary, not a nicety.
  it.each([
    ["http (not https)", "http://github.com/o/r"],
    ["a non-github host", "https://gitlab.com/o/r"],
    ["a github lookalike", "https://notgithub.com/o/r"],
    ["a github-prefixed host", "https://github.com.evil.tld/o/r"],
    ["an ssh scheme", "git@github.com:o/r.git"],
    ["unparseable", "not a url"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
  ])("rejects %s", async (_label, repo_url) => {
    const h = harness();
    const res = await tool(h).handler({ goal: "g", repo_url });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(h.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["apex github.com", "https://github.com/o/r"],
    ["a github subdomain", "https://www.github.com/o/r"],
    ["mixed case host", "https://GitHub.com/o/r"],
  ])("accepts %s", async (_label, repo_url) => {
    const h = harness();
    const res = await tool(h).handler({ goal: "g", repo_url });

    expect(res.isError).toBeUndefined();
  });

  it("reports agent_not_found and creates nothing when the caller is unknown", async () => {
    const h = harness({ agent: undefined });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("limit clamping", () => {
  it("passes through in-range limits", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 30, max_install_attempts: 3, disk_mb: 4096 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 30,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  // Caps are the blast radius of a runaway sandbox — an agent asking for
  // a 10-hour run with a 500GB disk gets the ceiling, not the ask.
  it("clamps each limit to its ceiling", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 500_000,
      },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional counts", async () => {
    const h = harness();
    const res = await tool(h).handler({
      ...GOOD,
      limits: { max_install_attempts: 3.9, disk_mb: 100.7 },
    });

    expect(res.content.limits).toEqual({
      max_install_attempts: 3,
      disk_mb: 100,
    });
  });

  it.each([
    ["zero", { wall_clock_minutes: 0, max_install_attempts: 0, disk_mb: 0 }],
    ["negative", { wall_clock_minutes: -5, disk_mb: -1 }],
    ["non-numeric", { wall_clock_minutes: "20", disk_mb: null }],
  ])("drops %s limits, leaving the defaults to apply downstream", async (_l, limits) => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, limits });

    expect(res.content.limits).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["not an object", "fast"],
  ])("treats %s limits as none", async (_label, limits) => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, limits });

    expect(res.content.limits).toEqual({});
  });
});

describe("downstream failures", () => {
  it("reports dispatch_failed and never inserts a repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime available") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime available",
    });
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  // The orphan-session case: the session row landed, the repo_run insert
  // didn't. It self-recovers downstream, but the agent must not be left
  // waiting on a run that will never report.
  it("reports repo_run_create_failed rather than returning a run id", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(res.content.repo_run_id).toBeUndefined();
  });

  it.each([
    ["dispatch", "dispatchThrows", "dispatch_failed"],
    ["repo_run insert", "repoRunThrows", "repo_run_create_failed"],
  ])("stringifies a non-Error thrown from %s", async (_l, key, code) => {
    const h = harness({ [key]: "boom" } as Record<string, unknown>);
    const res = await tool(h).handler(GOOD);

    expect(res.content).toEqual({ error: code, message: "boom" });
  });
});
