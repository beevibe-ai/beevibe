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
import {
  createUseRepoTool,
  type UseRepoContext,
  type UseRepoServices,
} from "./use-repo.js";

/**
 * use_repo owns input validation (goal, GitHub URL, limit clamping), the
 * container-task + session + repo_run write order, and the failure
 * envelopes for each step. The fakes record the writes so the ordering
 * contract documented in the module (session before repo_run) is
 * actually asserted, not just assumed.
 */
interface Harness {
  services: UseRepoServices;
  taskCreates: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRunCreates: Array<Record<string, unknown>>;
  order: string[];
}

function harness(opts?: {
  agent?: Agent | undefined;
  dispatchThrows?: unknown;
  repoRunThrows?: unknown;
}): Harness {
  const taskCreates: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRunCreates: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const agent =
    opts && "agent" in opts
      ? opts.agent
      : ({ id: "agent_a", name: "Ada" } as unknown as Agent);

  const agentRepo = {
    findById: vi.fn(async () => {
      order.push("agent.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("task.create");
      taskCreates.push(row);
      return row as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      order.push("dispatch");
      dispatches.push(input);
      if (opts?.dispatchThrows !== undefined) throw opts.dispatchThrows;
      return {} as unknown;
    }),
  } as unknown as DispatchService;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRun.create");
      repoRunCreates.push(row);
      if (opts?.repoRunThrows !== undefined) throw opts.repoRunThrows;
      return row as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    taskCreates,
    dispatches,
    repoRunCreates,
    order,
  };
}

const ctx: UseRepoContext = { agentId: "agent_a" };
const REPO = "https://github.com/jsvine/pdfplumber";

describe("createUseRepoTool", () => {
  it("exposes the use_repo name and required inputs", () => {
    const tool = createUseRepoTool(ctx, harness().services);
    expect(tool.name).toBe("use_repo");
    expect(tool.schema).toMatchObject({
      type: "object",
      required: ["goal", "repo_url"],
      additionalProperties: false,
    });
  });

  it("tells the agent sandboxed installs are not host installs", () => {
    const tool = createUseRepoTool(ctx, harness().services);
    expect(tool.description).toContain("find_repo");
    expect(tool.description).toContain("repo_run_id");
  });
});

describe("use_repo validation", () => {
  it.each([
    ["an empty goal", { goal: "", repo_url: REPO }],
    ["a whitespace-only goal", { goal: "   ", repo_url: REPO }],
    ["a missing goal", { repo_url: REPO }],
    ["a non-string goal", { goal: 5, repo_url: REPO }],
  ])("refuses %s", async (_label, input) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler(input as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.order).toEqual([]);
  });

  it.each([
    ["a missing url", undefined],
    ["an empty url", ""],
    ["a non-HTTPS github url", "http://github.com/a/b"],
    ["a non-github host", "https://gitlab.com/a/b"],
    ["a host that merely starts with github.com", "https://github.com.evil.test/a/b"],
    ["a host that merely ends with github", "https://notgithub.com/a/b"],
    ["an unparseable url", "not a url"],
    ["an ssh remote", "git@github.com:a/b.git"],
  ])("refuses %s", async (_label, repoUrl) => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.order).toEqual([]);
  });

  it("accepts a github.com subdomain", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: "https://www.github.com/jsvine/pdfplumber",
    });

    expect(result.isError).toBeFalsy();
  });

  it("reports agent_not_found before writing anything", async () => {
    const h = harness({ agent: undefined });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.order).toEqual(["agent.findById"]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "  Extract the tables from this PDF as JSON  ",
      repo_url: `  ${REPO}  `,
    });

    // The module's comment makes this ordering load-bearing:
    // repo_run.session_id has an FK to session.id, and dispatchTask is
    // what creates the session row.
    expect(h.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);

    expect(h.taskCreates[0]).toMatchObject({
      title: "Extract the tables from this PDF as JSON",
      description: "Extract the tables from this PDF as JSON",
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });

    const dispatch = h.dispatches[0];
    expect(dispatch).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "Extract the tables from this PDF as JSON",
      reason: { kind: "fresh" },
    });

    const repoRun = h.repoRunCreates[0];
    expect(repoRun).toMatchObject({
      goal: "Extract the tables from this PDF as JSON",
      repo_url: REPO,
      agent_id: "agent_a",
      status: "pending",
    });

    // The pre-minted session id is what ties the two writes together.
    expect(repoRun?.session_id).toBe(dispatch?.sessionIdOverride);
    expect(repoRun?.task_id).toBe(h.taskCreates[0]?.id);

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      repo_run_id: repoRun?.id,
      session_id: repoRun?.session_id,
      task_id: h.taskCreates[0]?.id,
      status: "pending",
      watch_url: `/capabilities/runs/${String(repoRun?.id)}`,
      limits: {},
    });
    expect(String(result.content.note)).toContain("repo_run.status");
  });

  it("mints a fresh repo_run, session and task id per call", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const a = await tool.handler({ goal: "one", repo_url: REPO });
    const b = await tool.handler({ goal: "two", repo_url: REPO });

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });

  it("collapses whitespace and truncates a long goal for the task title", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);
    const goal = `Extract   every\n  table ${"x".repeat(120)}`;

    await tool.handler({ goal, repo_url: REPO });

    const title = String(h.taskCreates[0]?.title);
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Extract every table")).toBe(true);
    // The full goal still reaches the description and the repo_run.
    expect(h.taskCreates[0]?.description).toBe(goal.trim());
  });

  it("keeps a goal of exactly 80 characters intact", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);
    const goal = "y".repeat(80);

    await tool.handler({ goal, repo_url: REPO });

    expect(h.taskCreates[0]?.title).toBe(goal);
  });

  it("echoes trimmed input_url and input_filename", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("omits non-string input_url and input_filename", async () => {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      input_url: 1,
      input_filename: null,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit parsing", () => {
  async function limitsFor(raw: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const tool = createUseRepoTool(ctx, h.services);
    const result = await tool.handler({
      goal: "extract tables",
      repo_url: REPO,
      limits: raw,
    });
    return result.content.limits as Record<string, unknown>;
  }

  it("passes through in-range limits", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 1024,
      }),
    ).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 999_999,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional install attempts and disk", async () => {
    expect(
      await limitsFor({ max_install_attempts: 2.9, disk_mb: 1536.7 }),
    ).toEqual({ max_install_attempts: 2, disk_mb: 1536 });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "20"],
    ["null", null],
  ])("drops %s limit values", async (_label, value) => {
    expect(
      await limitsFor({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });

  it.each([
    ["a missing object", undefined],
    ["null", null],
    ["a scalar", 20],
  ])("defaults to no limits for %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const h = harness({ dispatchThrows: new Error("no daemon online") });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.repoRunCreates).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "queue closed" });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "queue closed",
    });
  });

  it("surfaces repo_run_create_failed so the agent does not wait on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already dispatched — that's the orphan the
    // module's comment describes.
    expect(h.dispatches).toHaveLength(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: 23505 });
    const tool = createUseRepoTool(ctx, h.services);

    const result = await tool.handler({ goal: "extract tables", repo_url: REPO });

    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "23505",
    });
  });
});
