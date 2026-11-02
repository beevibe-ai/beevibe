/**
 * use_repo tool tests.
 *
 * The handler is a validation gate plus a three-write sequence whose
 * *ordering* is the load-bearing part: repo_run.session_id carries an FK
 * to session.id, so dispatchTask (which inserts the session row under our
 * pre-minted id) must land before repoRunRepo.create. The comment in
 * use-repo.ts spells that out; these tests hold it in place, along with
 * the two partial-failure exits that the ordering creates.
 *
 * Everything the tool touches is an injected port, so no DB is needed.
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

const AGENT: Agent = { id: "agent_a", name: "Ada" } as unknown as Agent;

interface Harness {
  services: UseRepoServices;
  calls: string[];
  dispatchArgs: Array<Record<string, unknown>>;
  repoRunArgs: Array<Record<string, unknown>>;
  taskArgs: Array<Record<string, unknown>>;
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  // One shared log across all three ports — assertions on this array are
  // how the FK ordering gets pinned.
  const calls: string[] = [];
  const dispatchArgs: Array<Record<string, unknown>> = [];
  const repoRunArgs: Array<Record<string, unknown>> = [];
  const taskArgs: Array<Record<string, unknown>> = [];

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("agent.findById");
      return "agent" in opts ? opts.agent : AGENT;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("task.create");
      taskArgs.push(input);
      return { ...input, status: "todo" } as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRun.create");
      repoRunArgs.push(input);
      if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
      return input as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatch.dispatchTask");
      dispatchArgs.push(input);
      if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
      return {} as never;
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    calls,
    dispatchArgs,
    repoRunArgs,
    taskArgs,
  };
}

function build(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  return { tool: createUseRepoTool({ agentId: "agent_a" }, h.services), ...h };
}

const GOOD = { goal: "Extract tables", repo_url: "https://github.com/acme/tool" };

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = build();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    // additionalProperties:false is what keeps a typo'd arg from being
    // silently swallowed by the MCP client.
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any port", async () => {
    const { tool, calls } = build();
    const res = await tool.handler({ repo_url: GOOD.repo_url });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_goal" });
    expect(calls).toEqual([]);
  });

  it("rejects a whitespace-only goal (trimmed to empty)", async () => {
    const { tool, calls } = build();
    const res = await tool.handler({ goal: "   \n ", repo_url: GOOD.repo_url });
    expect(res.content).toMatchObject({ error: "invalid_goal" });
    expect(calls).toEqual([]);
  });

  it("rejects a non-string goal", async () => {
    const { tool } = build();
    const res = await tool.handler({ goal: 42, repo_url: GOOD.repo_url });
    expect(res.content).toMatchObject({ error: "invalid_goal" });
  });

  // The URL gate is a allow-list on host + scheme, so each rejection
  // reason gets its own case rather than one table-driven blur.
  it("rejects a non-GitHub host", async () => {
    const { tool, calls } = build();
    const res = await tool.handler({ ...GOOD, repo_url: "https://gitlab.com/a/b" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    expect(calls).toEqual([]);
  });

  it("rejects http:// even on github.com", async () => {
    const { tool } = build();
    const res = await tool.handler({ ...GOOD, repo_url: "http://github.com/a/b" });
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it("rejects a host that merely ends in a github.com lookalike", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      repo_url: "https://notgithub.com/a/b",
    });
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it("rejects a non-string repo_url", async () => {
    const { tool, calls } = build();
    const res = await tool.handler({ ...GOOD, repo_url: 12345 });
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
    expect(calls).toEqual([]);
  });

  it("rejects an unparseable URL", async () => {
    const { tool } = build();
    const res = await tool.handler({ ...GOOD, repo_url: "not a url" });
    expect(res.content).toMatchObject({ error: "invalid_repo_url" });
  });

  it("accepts a github.com subdomain", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      repo_url: "https://www.github.com/acme/tool",
    });
    expect(res.isError).toBeFalsy();
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const { tool, calls } = build({ agent: undefined });
    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({ error: "agent_not_found" });
    // Looked the agent up, then stopped — no task row for a ghost caller.
    expect(calls).toEqual(["agent.findById"]);
  });
});

describe("use_repo happy path", () => {
  it("dispatches before inserting repo_run (session FK ordering)", async () => {
    const { tool, calls } = build();
    await tool.handler(GOOD);
    expect(calls).toEqual([
      "agent.findById",
      "task.create",
      "dispatch.dispatchTask",
      "repoRun.create",
    ]);
  });

  it("threads one pre-minted session id through dispatch and repo_run", async () => {
    const { tool, dispatchArgs, repoRunArgs } = build();
    const res = await tool.handler(GOOD);

    const minted = dispatchArgs[0]?.sessionIdOverride;
    expect(typeof minted).toBe("string");
    // The whole point of pre-minting: the repo_run FK must point at the
    // session dispatch just created, and the agent must get that same id.
    expect(repoRunArgs[0]?.session_id).toBe(minted);
    expect(res.content.session_id).toBe(minted);
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const { tool, taskArgs } = build();
    await tool.handler(GOOD);
    expect(taskArgs[0]).toMatchObject({
      title: "Extract tables",
      description: "Extract tables",
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session carrying the goal as intent", async () => {
    const { tool, dispatchArgs } = build();
    await tool.handler(GOOD);
    expect(dispatchArgs[0]).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "Extract tables",
      reason: { kind: "fresh" },
    });
  });

  it("creates the repo_run pending, tied to the container task", async () => {
    const { tool, repoRunArgs, taskArgs } = build();
    const res = await tool.handler(GOOD);
    expect(repoRunArgs[0]).toMatchObject({
      task_id: taskArgs[0]?.id,
      agent_id: "agent_a",
      goal: "Extract tables",
      repo_url: "https://github.com/acme/tool",
      status: "pending",
    });
    expect(res.content).toMatchObject({ status: "pending" });
  });

  it("returns the watch_url built from the repo_run id", async () => {
    const { tool } = build();
    const res = await tool.handler(GOOD);
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${String(res.content.repo_run_id)}`,
    );
  });

  it("trims the goal and repo_url before storing them", async () => {
    const { tool, repoRunArgs } = build();
    await tool.handler({
      goal: "  Extract tables  ",
      repo_url: "  https://github.com/acme/tool  ",
    });
    expect(repoRunArgs[0]).toMatchObject({
      goal: "Extract tables",
      repo_url: "https://github.com/acme/tool",
    });
  });

  it("passes input_url and input_filename straight back, trimmed", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      input_url: "  https://x.test/a.pdf ",
      input_filename: " a.pdf ",
    });
    expect(res.content).toMatchObject({
      input_url: "https://x.test/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("omits input fields when they are absent or not strings", async () => {
    const { tool } = build();
    const res = await tool.handler({ ...GOOD, input_url: 5 });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo container task title", () => {
  it("collapses runs of whitespace", async () => {
    const { tool, taskArgs } = build();
    await tool.handler({ ...GOOD, goal: "Extract\n\n  the   tables" });
    expect(taskArgs[0]?.title).toBe("Extract the tables");
  });

  it("keeps an 80-char goal intact", async () => {
    const { tool, taskArgs } = build();
    const goal = "x".repeat(80);
    await tool.handler({ ...GOOD, goal });
    expect(taskArgs[0]?.title).toBe(goal);
    // Untruncated title, but the full goal still reaches description.
    expect(taskArgs[0]?.description).toBe(goal);
  });

  it("truncates an 81-char goal to 77 chars plus an ellipsis", async () => {
    const { tool, taskArgs } = build();
    const goal = "y".repeat(81);
    await tool.handler({ ...GOOD, goal });
    expect(taskArgs[0]?.title).toBe("y".repeat(77) + "…");
    expect(String(taskArgs[0]?.title)).toHaveLength(78);
    // Truncation is cosmetic — description keeps every character.
    expect(taskArgs[0]?.description).toBe(goal);
  });
});

describe("use_repo limits parsing", () => {
  it("returns an empty object when limits is absent or not an object", async () => {
    const { tool } = build();
    expect((await tool.handler(GOOD)).content.limits).toEqual({});
    expect((await tool.handler({ ...GOOD, limits: 7 })).content.limits).toEqual({});
    expect((await tool.handler({ ...GOOD, limits: null })).content.limits).toEqual({});
  });

  it("passes through in-range limits", async () => {
    const { tool } = build();
    const res = await tool.handler({
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
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 50_000,
      },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk counts but not wall clock", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 100.7,
      },
    });
    expect(res.content.limits).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric limits rather than clamping them up", async () => {
    const { tool } = build();
    const res = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });
    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo partial-failure exits", () => {
  it("reports dispatch_failed and never inserts repo_run", async () => {
    const { tool, calls } = build({ dispatchThrows: new Error("daemon offline") });
    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(calls).not.toContain("repoRun.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool } = build({ dispatchThrows: "boom" });
    const res = await tool.handler(GOOD);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  // The orphan-session case the source comments call out: the session row
  // landed, the repo_run insert did not. Self-recovering, but the agent
  // must be told instead of waiting on a run that will never start.
  it("reports repo_run_create_failed when the insert fails after dispatch", async () => {
    const { tool, calls } = build({ repoRunThrows: new Error("unique violation") });
    const res = await tool.handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "unique violation",
    });
    expect(calls).toContain("dispatch.dispatchTask");
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool } = build({ repoRunThrows: { code: 23505 } });
    const res = await tool.handler(GOOD);
    expect(res.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof res.content.message).toBe("string");
  });
});
