/**
 * Unit tests for the `use_repo` MCP tool.
 *
 * Everything the handler touches is injected (agentRepo, taskRepo,
 * repoRunRepo, dispatchService), so the whole module is exercisable
 * without Postgres or Docker. The cases below pin the three things the
 * module actually owns on top of its collaborators:
 *
 *   1. input validation (goal, repo_url host/protocol, limit clamps),
 *   2. the dispatch-then-insert ordering the repo_run FK requires,
 *   3. the error envelope for each failure point.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRun,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

/** Records call order across collaborators so FK ordering is assertable. */
interface Harness {
  services: UseRepoServices;
  order: string[];
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const order: string[] = [];
  const agent =
    opts.agent === undefined && !("agent" in opts)
      ? ({ id: "agent_caller" } as unknown as Agent)
      : opts.agent;

  const findById = vi.fn(async (id: string) => {
    order.push(`findById:${id}`);
    return agent;
  });

  const createTask = vi.fn(async (input: Record<string, unknown>) => {
    order.push("task.create");
    return { ...input } as unknown as Task;
  });

  const dispatchTask = vi.fn(async () => {
    order.push("dispatch");
    if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
    return {} as never;
  });

  const createRepoRun = vi.fn(async (input: Record<string, unknown>) => {
    order.push("repoRun.create");
    if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
    return { ...input } as unknown as RepoRun;
  });

  const services = {
    agentRepo: { findById } as unknown as AgentRepository,
    taskRepo: { create: createTask } as unknown as TaskRepository,
    repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  };

  return { services, order, findById, createTask, dispatchTask, createRepoRun };
}

function build(h: Harness, agentId = "agent_caller") {
  return createUseRepoTool({ agentId }, h.services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool — surface", () => {
  it("exposes the tool name and marks goal + repo_url required", () => {
    const tool = build(harness());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.description).toContain("Docker sandbox");
  });
});

describe("use_repo tool — goal validation", () => {
  it.each([
    ["missing", { goal: undefined }],
    ["empty string", { goal: "" }],
    ["whitespace only", { goal: "   \n\t " }],
    ["non-string", { goal: 42 }],
  ])("rejects a %s goal without touching any collaborator", async (_label, patch) => {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, ...patch });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.order).toEqual([]);
  });
});

describe("use_repo tool — repo_url validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a URL at all", "jsvine/pdfplumber"],
    ["http, not https", "http://github.com/jsvine/pdfplumber"],
    ["a non-github host", "https://gitlab.com/jsvine/pdfplumber"],
    ["github as a subdomain of someone else", "https://github.com.evil.test/x/y"],
    ["a host merely containing github.com", "https://notgithub.com/x/y"],
    ["an ssh-style ref", "git@github.com:jsvine/pdfplumber.git"],
  ])("rejects %s", async (_label, repo_url) => {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://GitHub.com/jsvine/pdfplumber",
  ])("accepts %s", async (repo_url) => {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, repo_url });

    expect(result.isError).toBeFalsy();
    expect(h.createRepoRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo_url }),
    );
  });

  it("trims surrounding whitespace before validating", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: "  do the thing  ",
      repo_url: "  https://github.com/o/r  ",
    });

    expect(result.isError).toBeFalsy();
    expect(h.createRepoRun).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "do the thing",
        repo_url: "https://github.com/o/r",
      }),
    );
  });
});

describe("use_repo tool — caller resolution", () => {
  it("returns agent_not_found when the calling agent is gone", async () => {
    const h = harness({ agent: undefined });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Looked the agent up, then stopped — no task, no dispatch.
    expect(h.order).toEqual(["findById:agent_caller"]);
  });

  it("looks up the agent id from the tool context", async () => {
    const h = harness();
    await build(h, "agent_from_token").handler(GOOD);
    expect(h.findById).toHaveBeenCalledWith("agent_from_token");
  });
});

describe("use_repo tool — happy path", () => {
  it("creates the container task, dispatches, then inserts repo_run in that order", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBeFalsy();
    // repo_run.session_id has an FK to session.id, and dispatchTask is what
    // creates the session row — so the insert must come last.
    expect(h.order).toEqual([
      "findById:agent_caller",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);
  });

  it("pins the container task to the calling agent as both creator and assignee", async () => {
    const h = harness();
    await build(h).handler(GOOD);

    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: GOOD.goal,
        description: GOOD.goal,
        priority: "medium",
        assignee_id: "agent_caller",
        creator_id: "agent_caller",
        creator_type: "agent",
      }),
    );
    expect(h.createTask.mock.calls[0]?.[0].id).toMatch(/^task_/);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);
    const sessionIdValue = (result.content as { session_id: string }).session_id;

    expect(h.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_caller",
        type: "run_repo",
        intent: GOOD.goal,
        reason: { kind: "fresh" },
        sessionIdOverride: sessionIdValue,
      }),
    );
    // The dispatched task is the container task we just created.
    expect(h.dispatchTask.mock.calls[0]?.[0].task).toBe(
      await h.createTask.mock.results[0]?.value,
    );
  });

  it("inserts repo_run joining the session, task and agent, status pending", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);
    const content = result.content as Record<string, string>;

    expect(h.createRepoRun).toHaveBeenCalledWith({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_caller",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("returns the minted ids, a pending status and the watch url", async () => {
    const h = harness();
    const result = await build(h).handler(GOOD);
    const content = result.content as Record<string, unknown>;

    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.note).toContain("Sandbox run started");
  });

  it("mints a fresh set of ids per call", async () => {
    const h = harness();
    const a = (await build(h).handler(GOOD)).content as Record<string, string>;
    const b = (await build(h).handler(GOOD)).content as Record<string, string>;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.task_id).not.toBe(b.task_id);
  });
});

describe("use_repo tool — container task title", () => {
  it("collapses internal whitespace", async () => {
    const h = harness();
    await build(h).handler({ ...GOOD, goal: "extract\n\ttables   now" });

    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "extract tables now" }),
    );
  });

  it("keeps an 80-character goal intact", async () => {
    const h = harness();
    const goal = "x".repeat(80);
    await build(h).handler({ ...GOOD, goal });

    expect(h.createTask.mock.calls[0]?.[0].title).toBe(goal);
  });

  it("truncates a longer goal to 77 chars plus an ellipsis, leaving description full", async () => {
    const h = harness();
    const goal = "y".repeat(200);
    await build(h).handler({ ...GOOD, goal });

    const created = h.createTask.mock.calls[0]?.[0];
    expect(created.title).toBe("y".repeat(77) + "…");
    expect(created.title).toHaveLength(78);
    expect(created.description).toBe(goal);
  });
});

describe("use_repo tool — optional inputs", () => {
  it("echoes trimmed input_url and input_filename", async () => {
    const h = harness();
    const result = await build(h).handler({
      ...GOOD,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves both undefined when absent or non-string", async () => {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, input_url: 7 });

    const content = result.content as Record<string, unknown>;
    expect(content.input_url).toBeUndefined();
    expect(content.input_filename).toBeUndefined();
  });
});

describe("use_repo tool — limit parsing", () => {
  async function limitsFor(limits: unknown) {
    const h = harness();
    const result = await build(h).handler({ ...GOOD, limits });
    return (result.content as { limits: Record<string, number> }).limits;
  }

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "20"],
  ])("yields an empty object for %s limits", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it("passes through in-range values untouched", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 25,
        max_install_attempts: 3,
        disk_mb: 4096,
      }),
    ).toEqual({
      wall_clock_minutes: 25,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("clamps each field to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 500_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer-valued caps", async () => {
    expect(
      await limitsFor({ max_install_attempts: 2.9, disk_mb: 1024.7 }),
    ).toEqual({ max_install_attempts: 2, disk_mb: 1024 });
  });

  it("keeps wall_clock_minutes fractional (only the ceiling is applied)", async () => {
    expect(await limitsFor({ wall_clock_minutes: 1.5 })).toEqual({
      wall_clock_minutes: 1.5,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "10"],
    ["NaN", Number.NaN],
  ])("drops %s values rather than clamping them", async (_label, value) => {
    expect(
      await limitsFor({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });

  it("keeps the fields that are valid when a sibling is not", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, disk_mb: -1 }),
    ).toEqual({ wall_clock_minutes: 10 });
  });
});

describe("use_repo tool — failure envelopes", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const h = harness({ dispatchThrows: new Error("daemon offline") });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error thrown from dispatch", async () => {
    const h = harness({ dispatchThrows: "boom" });
    const result = await build(h).handler(GOOD);

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("reports repo_run_create_failed when the insert loses the race", async () => {
    const h = harness({ repoRunThrows: new Error("fk violation") });
    const result = await build(h).handler(GOOD);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
    // The session was already dispatched; the caller needs to know.
    expect(h.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error thrown from the repo_run insert", async () => {
    const h = harness({ repoRunThrows: { code: "23503" } });
    const result = await build(h).handler(GOOD);

    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "[object Object]",
    });
  });
});
