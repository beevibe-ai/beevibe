/**
 * use_repo tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The sandbox run itself happens on the daemon; what this module owns is
 * the pre-flight: validate the goal and repo URL, confirm the caller
 * exists, mint the container task, then dispatch *before* inserting the
 * repo_run (repo_run.session_id has an FK to session.id). The ordering
 * and the per-step failure envelopes are the parts a caller depends on,
 * so they're what these tests pin.
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

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_a",
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Agent;
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_container",
    title: "Extract tables",
    status: "in_progress",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Task;
}

function buildServices(
  overrides: {
    agent?: Agent | undefined;
    taskCreate?: TaskRepository["create"];
    dispatchTask?: DispatchService["dispatchTask"];
    repoRunCreate?: RepoRunRepository["create"];
    /** Records the order in which the write steps ran. */
    order?: string[];
  } = {},
) {
  const order = overrides.order ?? [];

  const findById = vi.fn(async () =>
    "agent" in overrides ? overrides.agent : fakeAgent(),
  );
  const agentRepo = { findById } as unknown as AgentRepository;

  const taskCreate =
    overrides.taskCreate ??
    (vi.fn(async (input: { id: string; title: string }) => {
      order.push("task.create");
      return fakeTask({ id: input.id, title: input.title });
    }) as unknown as TaskRepository["create"]);
  const taskRepo = { create: taskCreate } as unknown as TaskRepository;

  const dispatchTask =
    overrides.dispatchTask ??
    (vi.fn(async () => {
      order.push("dispatch");
      return { sessionId: "ses_dispatched" };
    }) as unknown as DispatchService["dispatchTask"]);
  const dispatchService = {
    dispatchTask,
  } as unknown as DispatchService;

  const repoRunCreate =
    overrides.repoRunCreate ??
    (vi.fn(async (input: { id: string }) => {
      order.push("repoRun.create");
      return { id: input.id } as unknown as RepoRun;
    }) as unknown as RepoRunRepository["create"]);
  const repoRunRepo = { create: repoRunCreate } as unknown as RepoRunRepository;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    findById,
    taskCreate,
    dispatchTask,
    repoRunCreate,
    order,
  };
}

function buildTool(overrides: Parameters<typeof buildServices>[0] = {}) {
  const built = buildServices(overrides);
  const tool = createUseRepoTool({ agentId: "agent_a" }, built.services);
  return { ...built, tool };
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

// ── Descriptor ───────────────────────────────────────────────────────────

describe("use_repo descriptor", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = buildTool();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

// ── Input validation (nothing is written) ────────────────────────────────

describe("input validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["non-string", 42],
  ])("rejects a %s goal", async (_label, goal) => {
    const { tool, findById, taskCreate } = buildTool();

    const out = await tool.handler({ ...GOOD, goal });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "invalid_goal",
      message: "goal must be a non-empty string",
    });
    // Validation precedes every lookup and write.
    expect(findById).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 42],
    ["not a URL at all", "jsvine/pdfplumber"],
    ["plain http", "http://github.com/jsvine/pdfplumber"],
    ["a non-GitHub host", "https://gitlab.com/jsvine/pdfplumber"],
    ["a lookalike host", "https://notgithub.com/jsvine/pdfplumber"],
    ["a suffix-attack host", "https://github.com.evil.test/x/y"],
    ["an ssh remote", "git@github.com:jsvine/pdfplumber.git"],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const { tool, taskCreate } = buildTool();

    const out = await tool.handler({ ...GOOD, repo_url });

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "invalid_repo_url",
      message: "repo_url must be a GitHub HTTPS URL",
    });
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://gist.github.com/someone/abc123",
    "https://GitHub.com/jsvine/pdfplumber",
  ])("accepts %s", async (repo_url) => {
    const { tool, repoRunCreate } = buildTool();

    const out = await tool.handler({ ...GOOD, repo_url });

    expect(out.isError).toBeFalsy();
    expect(vi.mocked(repoRunCreate).mock.calls[0]?.[0]).toMatchObject({
      repo_url: repo_url.trim(),
    });
  });

  it("trims the goal and the repo_url before use", async () => {
    const { tool, taskCreate, repoRunCreate } = buildTool();

    await tool.handler({
      goal: "  Extract tables  ",
      repo_url: "  https://github.com/jsvine/pdfplumber  ",
    });

    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      description: "Extract tables",
    });
    expect(vi.mocked(repoRunCreate).mock.calls[0]?.[0]).toMatchObject({
      goal: "Extract tables",
      repo_url: "https://github.com/jsvine/pdfplumber",
    });
  });

  it("returns agent_not_found when the caller doesn't resolve", async () => {
    const { tool, taskCreate, dispatchTask } = buildTool({ agent: undefined });

    const out = await tool.handler(GOOD);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(dispatchTask).not.toHaveBeenCalled();
  });
});

// ── The container task ───────────────────────────────────────────────────

describe("container task", () => {
  it("pins creator and assignee to the resolved agent", async () => {
    const { tool, taskCreate } = buildTool({
      agent: fakeAgent({ id: "agent_resolved" }),
    });

    await tool.handler(GOOD);

    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_resolved",
      creator_id: "agent_resolved",
      creator_type: "agent",
    });
  });

  it("uses the goal as the title when it is short", async () => {
    const { tool, taskCreate } = buildTool();

    await tool.handler({ ...GOOD, goal: "Extract tables" });

    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      title: "Extract tables",
    });
  });

  it("collapses whitespace in the title", async () => {
    const { tool, taskCreate } = buildTool();

    await tool.handler({ ...GOOD, goal: "Extract\n\ttables   from  the PDF" });

    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      title: "Extract tables from the PDF",
    });
  });

  it("truncates a long title to 77 chars plus an ellipsis", async () => {
    const { tool, taskCreate } = buildTool();
    const goal = "x".repeat(200);

    await tool.handler({ ...GOOD, goal });

    const title = (
      vi.mocked(taskCreate).mock.calls[0]?.[0] as { title: string }
    ).title;
    expect(title).toBe("x".repeat(77) + "…");
    expect([...title]).toHaveLength(78);
    // The untruncated goal still reaches description + repo_run.goal.
    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      description: goal,
    });
  });

  it("leaves an exactly-80-char title alone", async () => {
    const { tool, taskCreate } = buildTool();

    await tool.handler({ ...GOOD, goal: "y".repeat(80) });

    expect(vi.mocked(taskCreate).mock.calls[0]?.[0]).toMatchObject({
      title: "y".repeat(80),
    });
  });
});

// ── Dispatch + repo_run, in that order ───────────────────────────────────

describe("dispatch and repo_run insert", () => {
  it("dispatches a run_repo session under a pre-minted id", async () => {
    const { tool, dispatchTask } = buildTool();

    const out = await tool.handler(GOOD);

    const arg = vi.mocked(dispatchTask).mock.calls[0]?.[0] as {
      agentId: string;
      type: string;
      intent: string;
      reason: unknown;
      sessionIdOverride: string;
      task: { id: string };
    };
    expect(arg).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    // The override is what the caller is handed back, and what the
    // repo_run row points at.
    expect(arg.sessionIdOverride).toBe(out.content.session_id);
    expect(arg.task.id).toBe(out.content.task_id);
  });

  it("creates the session before the repo_run row (FK ordering)", async () => {
    const { tool, order } = buildTool();

    await tool.handler(GOOD);

    expect(order).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("links the repo_run to the same session, task and agent", async () => {
    const { tool, repoRunCreate } = buildTool();

    const out = await tool.handler(GOOD);

    expect(vi.mocked(repoRunCreate).mock.calls[0]?.[0]).toMatchObject({
      id: out.content.repo_run_id,
      session_id: out.content.session_id,
      task_id: out.content.task_id,
      agent_id: "agent_a",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("returns dispatch_failed and skips the repo_run insert when dispatch throws", async () => {
    const { tool, repoRunCreate } = buildTool({
      dispatchTask: vi.fn(async () => {
        throw new Error("no runtime online");
      }) as unknown as DispatchService["dispatchTask"],
    });

    const out = await tool.handler(GOOD);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("returns repo_run_create_failed when only the repo_run insert throws", async () => {
    // The session row landed, so the run self-recovers as a failed
    // session — but the agent must not be left waiting silently.
    const { tool } = buildTool({
      repoRunCreate: vi.fn(async () => {
        throw new Error("duplicate key");
      }) as unknown as RepoRunRepository["create"],
    });

    const out = await tool.handler(GOOD);

    expect(out.isError).toBe(true);
    expect(out.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it.each([
    ["dispatch", "dispatch_failed"],
    ["repoRun", "repo_run_create_failed"],
  ])("stringifies a non-Error throw from %s", async (step, code) => {
    const thrower = vi.fn(async () => {
      throw "kaboom";
    });
    const { tool } = buildTool(
      step === "dispatch"
        ? { dispatchTask: thrower as unknown as DispatchService["dispatchTask"] }
        : {
            repoRunCreate:
              thrower as unknown as RepoRunRepository["create"],
          },
    );

    const out = await tool.handler(GOOD);

    expect(out.content).toEqual({ error: code, message: "kaboom" });
  });
});

// ── Success envelope ─────────────────────────────────────────────────────

describe("success envelope", () => {
  it("returns the ids, pending status and a watch url", async () => {
    const { tool, taskCreate } = buildTool();

    const out = await tool.handler(GOOD);

    expect(out.isError).toBeFalsy();
    expect(out.content).toMatchObject({ status: "pending" });
    // task_id is the id of the container task that was just created.
    expect(out.content.task_id).toBe(
      (vi.mocked(taskCreate).mock.calls[0]?.[0] as { id: string }).id,
    );
    expect(typeof out.content.repo_run_id).toBe("string");
    expect(typeof out.content.session_id).toBe("string");
    expect(out.content.watch_url).toBe(
      `/capabilities/runs/${String(out.content.repo_run_id)}`,
    );
    // The note is the "don't call me again while one is in flight" hint.
    expect(String(out.content.note)).toContain("Sandbox run started");
  });

  it("mints a fresh id pair per call", async () => {
    const { tool } = buildTool();

    const a = await tool.handler(GOOD);
    const b = await tool.handler(GOOD);

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });

  it("echoes trimmed input_url and input_filename", async () => {
    const { tool } = buildTool();

    const out = await tool.handler({
      ...GOOD,
      input_url: "  https://example.test/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(out.content).toMatchObject({
      input_url: "https://example.test/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("leaves input_url and input_filename undefined when absent", async () => {
    const { tool } = buildTool();

    const out = await tool.handler(GOOD);

    expect(out.content.input_url).toBeUndefined();
    expect(out.content.input_filename).toBeUndefined();
  });
});

// ── Limit parsing ────────────────────────────────────────────────────────

describe("limits", () => {
  it("passes sane limits through untouched", async () => {
    const { tool } = buildTool();

    const out = await tool.handler({
      ...GOOD,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 2048 },
    });

    expect(out.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 2048,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const { tool } = buildTool();

    const out = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      },
    });

    expect(out.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer limits but not the wall clock", async () => {
    const { tool } = buildTool();

    const out = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 1.5,
        max_install_attempts: 2.9,
        disk_mb: 512.7,
      },
    });

    expect(out.content.limits).toEqual({
      wall_clock_minutes: 1.5,
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric limits, leaving defaults to the runner", async () => {
    const { tool } = buildTool();

    const out = await tool.handler({
      ...GOOD,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });

    expect(out.content.limits).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "20m"],
    ["a number", 20],
  ])("treats %s limits as no limits", async (_label, limits) => {
    const { tool } = buildTool();

    const out = await tool.handler({ ...GOOD, limits });

    expect(out.content.limits).toEqual({});
  });
});
