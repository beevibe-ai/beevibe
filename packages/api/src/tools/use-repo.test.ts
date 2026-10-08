/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is a four-step pipeline with an early return at each
 * step: validate goal + repo_url, resolve the caller agent, create the
 * container task, dispatch the session, insert the repo_run. Ordering
 * matters at the tail (repo_run.session_id FKs to session.id), so the
 * happy-path test asserts the task → dispatch → repo_run sequence and
 * that the session id handed to dispatch is the same one recorded on
 * the repo_run — the invariant a future refactor would most easily
 * break.
 *
 * `limits` clamping and the GitHub-URL guard are pure and exercised
 * through the handler rather than exported separately.
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
import { createUseRepoTool } from "./use-repo.js";

const AGENT = "agent_ic";
const REPO = "https://github.com/yt-dlp/yt-dlp";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Worker",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface Harness {
  calls: string[];
  findById: ReturnType<typeof vi.fn>;
  taskCreate: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  repoRunCreate: ReturnType<typeof vi.fn>;
}

function makeTool(
  opts: {
    agent?: Agent | null;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const findById = vi.fn(async () => {
    calls.push("agent.findById");
    return opts.agent === undefined ? fakeAgent() : opts.agent;
  });
  const taskCreate = vi.fn(async (input: Partial<Task>) => {
    calls.push("task.create");
    return {
      status: "open",
      created_at: new Date("2026-06-01T00:00:00Z"),
      updated_at: new Date("2026-06-01T00:00:00Z"),
      ...input,
    } as Task;
  });
  const dispatchTask = vi.fn(async () => {
    calls.push("dispatch");
    if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
    return { session: { id: "ignored" }, runtime_id: null };
  });
  const repoRunCreate = vi.fn(async (input: Partial<RepoRun>) => {
    calls.push("repoRun.create");
    if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
    return input as RepoRun;
  });

  const tool = createUseRepoTool(
    { agentId: AGENT },
    {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: taskCreate } as unknown as TaskRepository,
      repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
      dispatchService: { dispatchTask } as unknown as DispatchService,
    },
  );
  const harness: Harness = { calls, findById, taskCreate, dispatchTask, repoRunCreate };
  return { tool, ...harness };
}

describe("use_repo tool shape", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("points agents at find_repo for discovery", () => {
    const { tool } = makeTool();
    expect(tool.description).toContain("find_repo");
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing or blank goal before touching any port", async () => {
    for (const goal of [undefined, "", "   ", 7]) {
      const { tool, findById } = makeTool();
      const res = await tool.handler({ goal, repo_url: REPO });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({ error: "invalid_goal" });
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["http, not https", "http://github.com/a/b"],
    ["a non-GitHub host", "https://gitlab.com/a/b"],
    ["a lookalike host", "https://github.com.evil.test/a/b"],
    ["unparseable", "not a url"],
    ["a non-string", 42],
  ])("rejects a repo_url that is %s", async (_label, repo_url) => {
    const { tool, findById } = makeTool();
    const res = await tool.handler({ goal: "do a thing", repo_url });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "https://GitHub.com/acme/tool",
  ])("accepts %s", async (repo_url) => {
    const { tool } = makeTool();
    const res = await tool.handler({ goal: "do a thing", repo_url });
    expect(res.isError).toBeUndefined();
  });

  it("404s when the calling agent no longer exists", async () => {
    const { tool, taskCreate } = makeTool({ agent: null });
    const res = await tool.handler({ goal: "do a thing", repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const { tool, calls, taskCreate, dispatchTask, repoRunCreate } = makeTool();

    const res = await tool.handler({
      goal: "  Extract the tables from this PDF as JSON  ",
      repo_url: REPO,
    });

    expect(calls).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);

    const task = taskCreate.mock.calls[0]?.[0] as Task;
    expect(task).toMatchObject({
      title: "Extract the tables from this PDF as JSON",
      description: "Extract the tables from this PDF as JSON",
      priority: "medium",
      assignee_id: AGENT,
      creator_id: AGENT,
      creator_type: "agent",
    });
    expect(task.id).toMatch(/^task_/);

    expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      agentId: AGENT,
      type: "run_repo",
      intent: "Extract the tables from this PDF as JSON",
      reason: { kind: "fresh" },
    });

    const run = repoRunCreate.mock.calls[0]?.[0] as RepoRun;
    expect(run).toMatchObject({
      agent_id: AGENT,
      goal: "Extract the tables from this PDF as JSON",
      repo_url: REPO,
      status: "pending",
      task_id: task.id,
    });
    expect(run.id).toMatch(/^repo_/);

    // The FK invariant: the session row dispatch created is the one the
    // repo_run points at, and both are echoed back to the agent.
    const dispatchedSessionId = (
      dispatchTask.mock.calls[0]?.[0] as { sessionIdOverride: string }
    ).sessionIdOverride;
    expect(dispatchedSessionId).toMatch(/^sess_/);
    expect(run.session_id).toBe(dispatchedSessionId);

    expect(res.isError).toBeUndefined();
    expect(res.content).toMatchObject({
      repo_run_id: run.id,
      session_id: dispatchedSessionId,
      task_id: task.id,
      status: "pending",
      watch_url: `/capabilities/runs/${run.id}`,
      limits: {},
    });
    expect(res.content.note).toContain("poll");
  });

  it("truncates a long goal for the container task title but keeps it whole as the goal", async () => {
    const { tool, taskCreate, repoRunCreate } = makeTool();
    const goal = "x".repeat(200);

    await tool.handler({ goal, repo_url: REPO });

    const title = (taskCreate.mock.calls[0]?.[0] as Task).title;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    expect((repoRunCreate.mock.calls[0]?.[0] as RepoRun).goal).toBe(goal);
  });

  it("collapses whitespace in the title", async () => {
    const { tool, taskCreate } = makeTool();
    await tool.handler({ goal: "pull\n\tthe   audio", repo_url: REPO });
    expect((taskCreate.mock.calls[0]?.[0] as Task).title).toBe("pull the audio");
  });

  it("echoes a trimmed input_url and input_filename back to the agent", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "transcode",
      repo_url: REPO,
      input_url: "  https://example.test/a.mp4  ",
      input_filename: "  a.mp4  ",
    });
    expect(res.content).toMatchObject({
      input_url: "https://example.test/a.mp4",
      input_filename: "a.mp4",
    });
  });

  it("omits input_url / input_filename when they aren't strings", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "transcode",
      repo_url: REPO,
      input_url: 1,
      input_filename: null,
    });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits parsing", () => {
  it("passes through in-range limits, flooring the integer ones", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "g",
      repo_url: REPO,
      limits: { wall_clock_minutes: 12, max_install_attempts: 3.9, disk_mb: 500.6 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 12,
      max_install_attempts: 3,
      disk_mb: 500,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const { tool } = makeTool();
    const res = await tool.handler({
      goal: "g",
      repo_url: REPO,
      limits: { wall_clock_minutes: 600, max_install_attempts: 99, disk_mb: 1e6 },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it.each([
    ["non-positive values", { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: 0 }],
    ["non-numeric values", { wall_clock_minutes: "10", disk_mb: null }],
    ["a non-object", "lots"],
    ["null", null],
  ])("drops %s", async (_label, limits) => {
    const { tool } = makeTool();
    const res = await tool.handler({ goal: "g", repo_url: REPO, limits });
    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { tool, repoRunCreate } = makeTool({
      dispatchThrows: new Error("no runtime bound"),
    });
    const res = await tool.handler({ goal: "g", repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = makeTool({ dispatchThrows: "offline" });
    const res = await tool.handler({ goal: "g", repo_url: REPO });
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "offline",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const { tool } = makeTool({ repoRunThrows: new Error("duplicate key") });
    const res = await tool.handler({ goal: "g", repo_url: REPO });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = makeTool({ repoRunThrows: { code: "23505" } });
    const res = await tool.handler({ goal: "g", repo_url: REPO });
    expect(res.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof res.content.message).toBe("string");
  });
});
