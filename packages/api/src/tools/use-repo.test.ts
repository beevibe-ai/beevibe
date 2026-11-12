/**
 * use_repo MCP tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is validation + a three-step write sequence, and the
 * ordering of that sequence is load-bearing: `repo_run.session_id` has
 * an FK to `session.id`, so dispatchTask (which inserts the session
 * row under our pre-minted override) MUST land before the repo_run
 * insert. These tests pin that order, the two distinct failure codes
 * for the two writes, and the clamping in `parseLimits` — the ceilings
 * are what stop an agent asking for a 10-hour sandbox.
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

const REPO = "https://github.com/acme/pdfplumber";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_a",
    name: "Ada",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container",
    title: "extract the tables",
    status: "pending",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Harness {
  calls: string[];
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  repoRunRepo: RepoRunRepository;
  dispatchService: DispatchService;
  createdTask: () => Record<string, unknown> | undefined;
  createdRepoRun: () => Record<string, unknown> | undefined;
  dispatchInput: () => Record<string, unknown> | undefined;
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchThrows?: unknown;
    repoRunThrows?: unknown;
  } = {},
): Harness {
  const calls: string[] = [];
  let createdTask: Record<string, unknown> | undefined;
  let createdRepoRun: Record<string, unknown> | undefined;
  let dispatchInput: Record<string, unknown> | undefined;
  const agent = "agent" in opts ? opts.agent : fakeAgent();

  const agentRepo = {
    findById: vi.fn(async () => {
      calls.push("agent.findById");
      return agent;
    }),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("task.create");
      createdTask = input;
      return fakeTask({
        id: String(input.id),
        title: String(input.title),
        description: input.description as string | undefined,
      });
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRun.create");
      if (opts.repoRunThrows) throw opts.repoRunThrows;
      createdRepoRun = input;
      return input as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("dispatch.dispatchTask");
      if (opts.dispatchThrows) throw opts.dispatchThrows;
      dispatchInput = input;
      return {
        session: { id: String(input.sessionIdOverride) },
        runtime_id: "rt_1",
      };
    }),
  } as unknown as DispatchService;

  return {
    calls,
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
    createdTask: () => createdTask,
    createdRepoRun: () => createdRepoRun,
    dispatchInput: () => dispatchInput,
  };
}

function tool(h: Harness, agentId = "agent_a") {
  return createUseRepoTool(
    { agentId },
    {
      agentRepo: h.agentRepo,
      taskRepo: h.taskRepo,
      repoRunRepo: h.repoRunRepo,
      dispatchService: h.dispatchService,
    },
  );
}

// ── happy path ───────────────────────────────────────────────────────────

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run — in that order", async () => {
    const h = harness();

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(h.calls).toEqual([
      "agent.findById",
      "task.create",
      "dispatch.dispatchTask",
      "repoRun.create",
    ]);
    expect(result.isError).toBeFalsy();
  });

  it("returns the three row ids plus the watch url and pending status", async () => {
    const h = harness();

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    const content = result.content as Record<string, unknown>;
    expect(content.status).toBe("pending");
    expect(typeof content.task_id).toBe("string");
    expect(typeof content.repo_run_id).toBe("string");
    expect(typeof content.session_id).toBe("string");
    expect(content.watch_url).toBe(`/capabilities/runs/${String(content.repo_run_id)}`);
    expect(String(content.note)).toContain("poll");
  });

  it("dispatches a run_repo session under the pre-minted session id the repo_run points at", async () => {
    const h = harness();

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    const content = result.content as Record<string, unknown>;
    expect(h.dispatchInput()).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: "extract the tables",
      reason: { kind: "fresh" },
      sessionIdOverride: content.session_id,
    });
    // The FK direction: repo_run.session_id must be the session that
    // dispatch just created, not a fresh id.
    expect(h.createdRepoRun()).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_a",
      goal: "extract the tables",
      repo_url: REPO,
      status: "pending",
    });
  });

  it("pins the container task's creator and assignee to the resolved agent id", async () => {
    const h = harness({ agent: fakeAgent({ id: "agent_resolved" }) });

    await tool(h, "agent_a").handler({ goal: "extract the tables", repo_url: REPO });

    expect(h.createdTask()).toMatchObject({
      assignee_id: "agent_resolved",
      creator_id: "agent_resolved",
      creator_type: "agent",
      priority: "medium",
    });
  });

  it("trims the goal and uses the full goal as the task description", async () => {
    const h = harness();

    await tool(h).handler({ goal: "  extract the tables  ", repo_url: `  ${REPO}  ` });

    expect(h.createdTask()).toMatchObject({
      title: "extract the tables",
      description: "extract the tables",
    });
    expect(h.createdRepoRun()).toMatchObject({ repo_url: REPO });
  });

  it("collapses whitespace and ellipsizes a task title past 80 chars", async () => {
    const h = harness();
    const goal = `pull   the\ntables ${"x".repeat(100)}`;

    await tool(h).handler({ goal, repo_url: REPO });

    const title = String(h.createdTask()?.title);
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title).toContain("pull the tables");
    // The description keeps the full goal even when the title is cut.
    expect(String(h.createdTask()?.description)).toHaveLength(goal.trim().length);
  });

  it("passes input_url / input_filename back trimmed, and omits them when absent", async () => {
    const h = harness();

    const withInput = await tool(h).handler({
      goal: "extract the tables",
      repo_url: REPO,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(withInput.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });

    const without = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });
    expect((without.content as Record<string, unknown>).input_url).toBeUndefined();
    expect((without.content as Record<string, unknown>).input_filename).toBeUndefined();
  });
});

// ── validation ───────────────────────────────────────────────────────────

describe("use_repo validation", () => {
  it("rejects a missing, blank or non-string goal before touching any repo", async () => {
    for (const goal of [undefined, "", "   ", 42]) {
      const h = harness();
      const result = await tool(h).handler({ goal, repo_url: REPO });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
      expect(h.calls).toEqual([]);
    }
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 42],
    ["http (not https)", "http://github.com/acme/tool"],
    ["a non-github host", "https://gitlab.com/acme/tool"],
    ["a lookalike host", "https://github.com.evil.test/acme/tool"],
    ["unparseable", "not a url"],
  ])("rejects a %s repo_url before touching any repo", async (_label, repoUrl) => {
    const h = harness();

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.calls).toEqual([]);
  });

  it.each([
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "https://GITHUB.COM/acme/tool",
  ])("accepts %s", async (repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: "extract the tables", repo_url: repoUrl });
    expect(result.isError).toBeFalsy();
  });

  it("404s when the calling agent row doesn't exist, without creating a task", async () => {
    const h = harness({ agent: undefined });

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.calls).toEqual(["agent.findById"]);
  });
});

// ── write failures ───────────────────────────────────────────────────────

describe("use_repo write failures", () => {
  it("reports dispatch_failed and never inserts the repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("no runtime bound") });

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no runtime bound",
    });
    expect(h.calls).not.toContain("repoRun.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "exploded" });

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "exploded",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("duplicate key") });

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session row did land — that's the documented orphan the
    // composeDispatchPayload null-path cleans up.
    expect(h.calls).toContain("dispatch.dispatchTask");
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: { code: 23505 } });

    const result = await tool(h).handler({ goal: "extract the tables", repo_url: REPO });

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(typeof (result.content as Record<string, unknown>).message).toBe("string");
  });
});

// ── limits clamping ──────────────────────────────────────────────────────

describe("use_repo limits", () => {
  async function limitsFor(raw: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const result = await tool(h).handler({
      goal: "extract the tables",
      repo_url: REPO,
      limits: raw,
    });
    return (result.content as Record<string, unknown>).limits as Record<string, unknown>;
  }

  it("echoes in-range limits unchanged", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 500 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 500 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric limits rather than passing them through", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "500",
      }),
    ).toEqual({});
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a non-object", "generous"],
  ])("returns an empty limits object when limits is %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });
});
