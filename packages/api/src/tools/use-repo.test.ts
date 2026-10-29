/**
 * use_repo — unit tests over faked repositories + DispatchService (no DB,
 * no Docker).
 *
 * The handler's risk isn't the happy path, it's everything around it:
 * the GitHub-URL guard (the only thing stopping an agent from pointing
 * the sandbox at an arbitrary host), the limits clamp (the sandbox's
 * only cost ceiling), and the two-step dispatch → repo_run insert whose
 * ORDER is load-bearing because `repo_run.session_id` has an FK to
 * `session.id`. Each failure point has to come back as a distinct
 * `error` code so the calling agent can tell "bad input" from "retry".
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
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT_ID = "agent_caller";

function fakeAgent(): Agent {
  return {
    id: AGENT_ID,
    name: "Scout",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
  };
}

interface Harness {
  services: UseRepoServices;
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
  const agent = "agent" in opts ? opts.agent : fakeAgent();

  const findById = vi.fn(async () => agent);
  const createTask = vi.fn(
    async (input: Partial<Task>) =>
      ({
        ...input,
        status: "pending",
        created_at: new Date("2026-04-02"),
        updated_at: new Date("2026-04-02"),
      }) as Task,
  );
  const dispatchTask = vi.fn(async () => {
    if (opts.dispatchThrows !== undefined) throw opts.dispatchThrows;
    return { session: { id: "ignored" } } as never;
  });
  const createRepoRun = vi.fn(async (row: unknown) => {
    if (opts.repoRunThrows !== undefined) throw opts.repoRunThrows;
    return row as never;
  });

  return {
    findById,
    createTask,
    dispatchTask,
    createRepoRun,
    services: {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: createTask } as unknown as TaskRepository,
      repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
      dispatchService: { dispatchTask } as unknown as DispatchService,
    },
  };
}

function tool(h: Harness) {
  return createUseRepoTool({ agentId: AGENT_ID }, h.services);
}

const GOOD = { goal: "Extract the tables from this PDF as JSON", repo_url: "https://github.com/jsvine/pdfplumber" };

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect((t.schema as { required: string[] }).required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, blank, or non-string goal before touching any repo", async () => {
    const h = harness();
    const t = tool(h);

    for (const goal of [undefined, "", "   ", 7]) {
      const res = await t.handler({ ...GOOD, goal });
      expect(res.isError).toBe(true);
      expect(res.content).toMatchObject({
        error: "invalid_goal",
        message: "goal must be a non-empty string",
      });
    }
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["non-string", 7],
    ["http (not https)", "http://github.com/owner/repo"],
    ["a non-GitHub host", "https://gitlab.com/owner/repo"],
    ["a lookalike host", "https://github.com.evil.test/owner/repo"],
    ["not a URL at all", "owner/repo"],
    ["an ssh remote", "git@github.com:owner/repo.git"],
  ])("rejects repo_url that is %s", async (_label, repo_url) => {
    const h = harness();
    const res = await tool(h).handler({ ...GOOD, repo_url });

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "invalid_repo_url",
      message: "repo_url must be a GitHub HTTPS URL",
    });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/owner/repo",
    "https://www.github.com/owner/repo",
    "https://GitHub.com/owner/repo",
  ])("accepts %s", async (repo_url) => {
    const res = await tool(harness()).handler({ ...GOOD, repo_url });
    expect(res.isError).toBeFalsy();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run in that order", async () => {
    const h = harness();
    const order: string[] = [];
    h.createTask.mockImplementation(async (input: Partial<Task>) => {
      order.push("task");
      return { ...input, status: "pending", created_at: new Date(), updated_at: new Date() } as Task;
    });
    h.dispatchTask.mockImplementation(async () => {
      order.push("dispatch");
      return undefined as never;
    });
    h.createRepoRun.mockImplementation(async (row: unknown) => {
      order.push("repo_run");
      return row as never;
    });

    const res = await tool(h).handler(GOOD);

    expect(order).toEqual(["task", "dispatch", "repo_run"]);
    expect(res.isError).toBeFalsy();
  });

  it("pins the container task to the resolved agent and carries the goal as description", async () => {
    const h = harness();
    await tool(h).handler(GOOD);

    expect(h.findById).toHaveBeenCalledWith(AGENT_ID);
    expect(h.createTask.mock.calls[0]?.[0]).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the pre-minted session id it returns", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);

    const dispatch = h.dispatchTask.mock.calls[0]?.[0] as {
      agentId: string;
      type: string;
      intent: string;
      reason: { kind: string };
      sessionIdOverride: string;
      task: Task;
    };
    const content = res.content as { session_id: string; task_id: string };

    expect(dispatch).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    expect(dispatch.sessionIdOverride).toBe(content.session_id);
    expect(dispatch.task.id).toBe(content.task_id);
  });

  it("inserts the repo_run against the same session, task and agent, status pending", async () => {
    const h = harness();
    const res = await tool(h).handler(GOOD);
    const content = res.content as {
      repo_run_id: string;
      session_id: string;
      task_id: string;
      status: string;
      watch_url: string;
    };

    expect(h.createRepoRun.mock.calls[0]?.[0]).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: AGENT_ID,
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
  });

  it("trims the goal and repo_url before storing them", async () => {
    const h = harness();
    await tool(h).handler({ goal: "  tidy me  ", repo_url: "  https://github.com/o/r  " });

    expect(h.createRepoRun.mock.calls[0]?.[0]).toMatchObject({
      goal: "tidy me",
      repo_url: "https://github.com/o/r",
    });
  });

  it("collapses whitespace in the task title and elides past 80 chars", async () => {
    const h = harness();
    const goal = `Extract   tables\nfrom ${"x".repeat(100)}`;
    await tool(h).handler({ ...GOOD, goal });

    // Over the 80-char threshold the title becomes slice(0, 77) + "…" — 78
    // chars, so the inbox row never wraps.
    const title = (h.createTask.mock.calls[0]?.[0] as { title: string }).title;
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Extract tables from ")).toBe(true);
  });

  it("leaves an exactly-80-char title untruncated", async () => {
    const h = harness();
    const goal = "y".repeat(80);
    await tool(h).handler({ ...GOOD, goal });

    expect((h.createTask.mock.calls[0]?.[0] as { title: string }).title).toBe(goal);
  });

  it("echoes trimmed input_url / input_filename, and omits them when absent", async () => {
    const h = harness();
    const withInput = await tool(h).handler({
      ...GOOD,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(withInput.content).toMatchObject({
      input_url: "https://example.test/a.pdf",
      input_filename: "a.pdf",
    });

    const without = await tool(harness()).handler(GOOD);
    expect((without.content as { input_url?: string }).input_url).toBeUndefined();
    expect((without.content as { input_filename?: string }).input_filename).toBeUndefined();
  });

  it("mints a fresh repo_run / session / task id per call", async () => {
    const h = harness();
    const t = tool(h);
    const a = (await t.handler(GOOD)).content as Record<string, string>;
    const b = (await t.handler(GOOD)).content as Record<string, string>;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.task_id).not.toBe(b.task_id);
  });
});

describe("use_repo limits clamping", () => {
  it("passes sane limits through untouched", async () => {
    const res = await tool(harness()).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 30, max_install_attempts: 3, disk_mb: 4096 },
    });
    expect((res.content as { limits: unknown }).limits).toEqual({
      wall_clock_minutes: 30,
      max_install_attempts: 3,
      disk_mb: 4096,
    });
  });

  it("caps each limit at its ceiling", async () => {
    const res = await tool(harness()).handler({
      ...GOOD,
      limits: { wall_clock_minutes: 999, max_install_attempts: 50, disk_mb: 999_999 },
    });
    expect((res.content as { limits: unknown }).limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk limits", async () => {
    const res = await tool(harness()).handler({
      ...GOOD,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });
    expect((res.content as { limits: unknown }).limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["not an object", "20"],
    ["all zero / negative", { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: 0 }],
    ["all non-numeric", { wall_clock_minutes: "20", max_install_attempts: null, disk_mb: [] }],
  ])("drops limits that are %s, leaving the sandbox defaults", async (_label, limits) => {
    const res = await tool(harness()).handler({ ...GOOD, limits });
    expect((res.content as { limits: unknown }).limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("reports agent_not_found and creates nothing when the caller is unknown", async () => {
    const h = harness({ agent: undefined });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("reports dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime online") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(h.createRepoRun).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed when the orphan-session insert fails", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });
    const res = await tool(h).handler(GOOD);

    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw on both failure paths", async () => {
    const dispatch = await tool(harness({ dispatchThrows: "boom" })).handler(GOOD);
    expect(dispatch.content).toMatchObject({ error: "dispatch_failed", message: "boom" });

    const repoRun = await tool(harness({ repoRunThrows: 42 })).handler(GOOD);
    expect(repoRun.content).toMatchObject({ error: "repo_run_create_failed", message: "42" });
  });
});
