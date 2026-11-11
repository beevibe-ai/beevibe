/**
 * use_repo handler tests.
 *
 * The handler's own work is validation (goal, GitHub-URL shape, limit
 * clamping) and a three-step write sequence whose ORDER is load-bearing:
 * container task → dispatch (mints the session row) → repo_run insert,
 * because repo_run.session_id has an FK to session.id. Both failure
 * points in that sequence have to surface as distinct error codes so the
 * agent doesn't silently wait on a run that never started.
 *
 * Repos and the dispatch service are fakes; no Postgres is involved.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

interface Harness {
  services: UseRepoServices;
  taskCreates: Array<Record<string, unknown>>;
  dispatches: Array<Record<string, unknown>>;
  repoRunCreates: Array<Record<string, unknown>>;
  order: string[];
}

function harness(opts?: {
  agent?: { id: string } | null;
  dispatchThrows?: unknown;
  repoRunThrows?: unknown;
}): Harness {
  const taskCreates: Array<Record<string, unknown>> = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const repoRunCreates: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const agent = opts?.agent === undefined ? { id: "agent_a" } : opts.agent;

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
      return { ...row, status: "pending" };
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (row: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (opts?.repoRunThrows !== undefined) throw opts.repoRunThrows;
      repoRunCreates.push(row);
      return row;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      order.push("dispatch");
      if (opts?.dispatchThrows !== undefined) throw opts.dispatchThrows;
      dispatches.push(input);
      return { sessionId: input.sessionIdOverride };
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    taskCreates,
    dispatches,
    repoRunCreates,
    order,
  };
}

const GOAL = "Extract the tables from this PDF as JSON";
const REPO = "https://github.com/jsvine/pdfplumber";

function tool(h: Harness) {
  return createUseRepoTool({ agentId: "agent_a" }, h.services);
}

describe("use_repo tool shape", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool(harness());
    expect(t.name).toBe("use_repo");
    expect(t.schema.required).toEqual(["goal", "repo_url"]);
    expect(t.schema.additionalProperties).toBe(false);
  });

  it("exposes the three documented limit knobs", () => {
    const t = tool(harness());
    const props = t.schema.properties as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(Object.keys(props.limits?.properties ?? {}).sort()).toEqual([
      "disk_mb",
      "max_install_attempts",
      "wall_clock_minutes",
    ]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    // FK ordering: the session row (minted by dispatch) must exist
    // before repo_run references it.
    expect(h.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      "repoRun.create",
    ]);
    expect(result.isError).toBeUndefined();
  });

  it("returns the minted ids and a watch url that matches the repo_run id", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    const repoRunId = result.content.repo_run_id as string;
    const sessionIdValue = result.content.session_id as string;
    const taskIdValue = result.content.task_id as string;

    expect(repoRunId).toMatch(/^repo_/);
    expect(sessionIdValue).toMatch(/^sess_/);
    expect(taskIdValue).toMatch(/^task_/);
    expect(result.content.status).toBe("pending");
    expect(result.content.watch_url).toBe(`/capabilities/runs/${repoRunId}`);
    expect(result.content.note).toContain("Sandbox run started");
  });

  it("ties the repo_run row to the same session dispatch was given", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    const run = h.repoRunCreates[0];
    expect(run?.session_id).toBe(h.dispatches[0]?.sessionIdOverride);
    expect(run?.session_id).toBe(result.content.session_id);
    expect(run?.task_id).toBe(result.content.task_id);
    expect(run).toMatchObject({
      agent_id: "agent_a",
      goal: GOAL,
      repo_url: REPO,
      status: "pending",
    });
  });

  it("dispatches a run_repo session carrying the goal as intent", async () => {
    const h = harness();
    await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(h.dispatches[0]).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOAL,
      reason: { kind: "fresh" },
    });
  });

  it("pins the container task to the resolved agent as both creator and assignee", async () => {
    const h = harness({ agent: { id: "agent_resolved" } });
    await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(h.taskCreates[0]).toMatchObject({
      title: GOAL,
      description: GOAL,
      priority: "medium",
      assignee_id: "agent_resolved",
      creator_id: "agent_resolved",
      creator_type: "agent",
    });
  });

  it("mints a fresh id trio per call", async () => {
    const h = harness();
    const a = await tool(h).handler({ goal: GOAL, repo_url: REPO });
    const b = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });

  it("trims goal and repo_url before use", async () => {
    const h = harness();
    await tool(h).handler({ goal: `  ${GOAL}  `, repo_url: `  ${REPO}  ` });

    expect(h.repoRunCreates[0]).toMatchObject({ goal: GOAL, repo_url: REPO });
  });
});

describe("container task title", () => {
  it("collapses whitespace in the goal", async () => {
    const h = harness();
    await tool(h).handler({
      goal: "Extract\n  the   tables\tas JSON",
      repo_url: REPO,
    });

    expect(h.taskCreates[0]?.title).toBe("Extract the tables as JSON");
  });

  it("keeps an 80-char goal whole", async () => {
    const h = harness();
    const goal = "x".repeat(80);
    await tool(h).handler({ goal, repo_url: REPO });

    expect(h.taskCreates[0]?.title).toBe(goal);
    expect((h.taskCreates[0]?.title as string).length).toBe(80);
  });

  it("truncates past 80 chars to 77 plus an ellipsis", async () => {
    const h = harness();
    const goal = "y".repeat(200);
    await tool(h).handler({ goal, repo_url: REPO });

    const title = h.taskCreates[0]?.title as string;
    expect(title).toBe("y".repeat(77) + "…");
    expect(title.length).toBe(78);
    // The full goal still reaches the description — only the title is cut.
    expect(h.taskCreates[0]?.description).toBe(goal);
  });
});

describe("input validation", () => {
  it.each([
    ["missing", {}],
    ["empty", { goal: "" }],
    ["whitespace only", { goal: "   " }],
    ["not a string", { goal: 12 }],
  ])("rejects a %s goal", async (_label, partial) => {
    const h = harness();
    const result = await tool(h).handler({ repo_url: REPO, ...partial });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_goal",
      message: "goal must be a non-empty string",
    });
    expect(h.order).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a url", "not a url at all"],
    ["http, not https", "http://github.com/o/r"],
    ["a non-github host", "https://gitlab.com/o/r"],
    ["a lookalike host", "https://github.com.evil.test/o/r"],
    ["a host merely containing github.com", "https://notgithub.com/o/r"],
    ["an ssh url", "git@github.com:o/r.git"],
    ["a non-string", 7],
  ])("rejects %s as repo_url", async (_label, repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "invalid_repo_url",
      message: "repo_url must be a GitHub HTTPS URL",
    });
    expect(h.order).toEqual([]);
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://GitHub.com/jsvine/pdfplumber",
    "https://gist.github.com/someone/abc",
    "https://github.com/jsvine/pdfplumber.git",
  ])("accepts %s", async (repoUrl) => {
    const h = harness();
    const result = await tool(h).handler({ goal: GOAL, repo_url: repoUrl });

    expect(result.isError).toBeUndefined();
    expect(h.repoRunCreates[0]?.repo_url).toBe(repoUrl.trim());
  });

  it("checks the goal before the repo_url", async () => {
    const h = harness();
    const result = await tool(h).handler({ goal: "", repo_url: "nonsense" });

    expect(result.content.error).toBe("invalid_goal");
  });
});

describe("optional input passthrough", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content.input_url).toBe("https://example.test/a.pdf");
    expect(result.content.input_filename).toBe("a.pdf");
  });

  it("leaves both undefined when absent or non-string", async () => {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: 5,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("limit parsing", () => {
  async function limitsFor(limits: unknown) {
    const h = harness();
    const result = await tool(h).handler({
      goal: GOAL,
      repo_url: REPO,
      limits,
    });
    return result.content.limits as Record<string, number>;
  }

  it("passes in-range limits through", async () => {
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
        disk_mb: 500_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk caps but not wall clock", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 100.7,
      }),
    ).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["a string", "10"],
    ["NaN", Number.NaN],
  ])("drops %s values so the sandbox default applies", async (_label, v) => {
    expect(
      await limitsFor({
        wall_clock_minutes: v,
        max_install_attempts: v,
        disk_mb: v,
      }),
    ).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "lots"],
    ["an empty object", {}],
  ])("yields no limits when %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it("keeps the recognized subset when only some keys are valid", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 5, disk_mb: -1, extra: "ignored" }),
    ).toEqual({ wall_clock_minutes: 5 });
  });
});

describe("failure paths", () => {
  it("stops before any write when the calling agent is gone", async () => {
    const h = harness({ agent: null });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(h.order).toEqual(["agent.findById"]);
  });

  it("reports dispatch_failed and never inserts the repo_run", async () => {
    const h = harness({ dispatchThrows: new Error("daemon offline") });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(h.order).not.toContain("repoRun.create");
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness({ dispatchThrows: "no runtime" });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime",
    });
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const h = harness({ repoRunThrows: new Error("fk violation") });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
    // The session was already dispatched — that's the orphan the code
    // comments describe, and it must not be reported as success.
    expect(h.dispatches).toHaveLength(1);
    expect(result.content.repo_run_id).toBeUndefined();
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunThrows: { code: "23503" } });
    const result = await tool(h).handler({ goal: GOAL, repo_url: REPO });

    expect(result.content.error).toBe("repo_run_create_failed");
    expect(result.content.message).toBe("[object Object]");
  });
});
