/**
 * use_repo tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is a four-step orchestration with a deliberate ordering
 * constraint: validate → look the agent up → create the container task →
 * dispatch (which mints the session row) → insert repo_run. Each step can
 * fail into a distinct error envelope, and the repo_run insert *must* come
 * after dispatch because `repo_run.session_id` has an FK to `session.id`.
 * That ordering is invisible in the types, so it is asserted here.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT = { id: "agent_a", name: "Alice" };

interface Fakes {
  services: UseRepoServices;
  /** Step name in call order, so ordering constraints are assertable. */
  order: string[];
  agentRepo: { findById: ReturnType<typeof vi.fn> };
  taskRepo: { create: ReturnType<typeof vi.fn> };
  repoRunRepo: { create: ReturnType<typeof vi.fn> };
  dispatchService: { dispatchTask: ReturnType<typeof vi.fn> };
}

function makeFakes(
  overrides: {
    agent?: unknown;
    dispatchThrows?: Error;
    repoRunThrows?: Error;
  } = {},
): Fakes {
  const order: string[] = [];

  const agentRepo = {
    findById: vi.fn(async () => {
      order.push("agent.findById");
      return "agent" in overrides ? overrides.agent : AGENT;
    }),
  };
  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      order.push("task.create");
      return { ...input, status: "pending" } as unknown as Task;
    }),
  };
  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      order.push("dispatch");
      if (overrides.dispatchThrows) throw overrides.dispatchThrows;
      return {} as never;
    }),
  };
  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      order.push("repoRun.create");
      if (overrides.repoRunThrows) throw overrides.repoRunThrows;
      return input as never;
    }),
  };

  return {
    order,
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
    services: {
      agentRepo: agentRepo as unknown as AgentRepository,
      taskRepo: taskRepo as unknown as TaskRepository,
      repoRunRepo: repoRunRepo as unknown as RepoRunRepository,
      dispatchService: dispatchService as unknown as DispatchService,
    },
  };
}

function makeTool(fakes: Fakes) {
  return createUseRepoTool({ agentId: AGENT.id }, fakes.services);
}

const VALID = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const tool = makeTool(makeFakes());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any service", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({ repo_url: VALID.repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(fakes.order).toEqual([]);
  });

  it("rejects a whitespace-only goal", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      goal: "   \n ",
      repo_url: VALID.repo_url,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  it("rejects a non-string goal", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      goal: 42,
      repo_url: VALID.repo_url,
    });

    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });

  // The URL guard is the sandbox's only input-provenance check, so each
  // rejected shape is pinned rather than spot-checked.
  it.each([
    ["missing", undefined],
    ["non-string", 7],
    ["empty", ""],
    ["plain http", "http://github.com/foo/bar"],
    ["git+ssh", "git@github.com:foo/bar.git"],
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    ["a lookalike host", "https://notgithub.com/foo/bar"],
    ["a GitHub-suffixed path on another host", "https://evil.com/github.com/x"],
    ["unparseable", "https://"],
  ])("rejects repo_url that is %s", async (_label, repo_url) => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({ goal: VALID.goal, repo_url });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(fakes.order).toEqual([]);
  });

  it.each([
    ["apex github.com", "https://github.com/jsvine/pdfplumber"],
    ["a www subdomain", "https://www.github.com/jsvine/pdfplumber"],
    ["mixed case host", "https://GitHub.com/jsvine/pdfplumber"],
  ])("accepts repo_url on %s", async (_label, repo_url) => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({ goal: VALID.goal, repo_url });

    expect(result.isError).toBeFalsy();
    expect(fakes.repoRunRepo.create.mock.calls[0]?.[0]).toMatchObject({
      repo_url,
    });
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const fakes = makeFakes({ agent: undefined });
    const result = await makeTool(fakes).handler(VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    // Nothing was written — the lookup is the gate, not a decoration.
    expect(fakes.order).toEqual(["agent.findById"]);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts repo_run — in that order", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler(VALID);

    expect(result.isError).toBeFalsy();
    expect(fakes.order).toEqual([
      "agent.findById",
      "task.create",
      "dispatch",
      // Must be last: repo_run.session_id FKs to the session row that
      // dispatchTask creates.
      "repoRun.create",
    ]);
  });

  it("pins the container task to the resolved agent on both creator and assignee", async () => {
    const fakes = makeFakes();
    await makeTool(fakes).handler(VALID);

    expect(fakes.taskRepo.create.mock.calls[0]?.[0]).toMatchObject({
      title: VALID.goal,
      description: VALID.goal,
      priority: "medium",
      assignee_id: AGENT.id,
      creator_id: AGENT.id,
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler(VALID);

    const dispatched = fakes.dispatchService.dispatchTask.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      agentId: AGENT.id,
      type: "run_repo",
      intent: VALID.goal,
      reason: { kind: "fresh" },
    });
    // The override is what lets the repo_run row point at this session.
    expect(dispatched.sessionIdOverride).toBe(
      (result.content as Record<string, string>).session_id,
    );
    expect(dispatched.task.id).toBe(
      (result.content as Record<string, string>).task_id,
    );
  });

  it("writes the repo_run row as pending, joined to the session and task", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler(VALID);
    const content = result.content as Record<string, string>;

    expect(fakes.repoRunRepo.create.mock.calls[0]?.[0]).toEqual({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: AGENT.id,
      goal: VALID.goal,
      repo_url: VALID.repo_url,
      status: "pending",
    });
  });

  it("returns the three ids with their domain prefixes plus the watch url", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler(VALID);
    const content = result.content as Record<string, string>;

    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toMatch(/^task_/);
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
    expect(content.note).toContain("Sandbox run started");
  });

  it("trims the goal before it reaches the task row and the repo_run row", async () => {
    const fakes = makeFakes();
    await makeTool(fakes).handler({
      goal: `  ${VALID.goal}  `,
      repo_url: `  ${VALID.repo_url}  `,
    });

    expect(fakes.taskRepo.create.mock.calls[0]?.[0]).toMatchObject({
      description: VALID.goal,
    });
    expect(fakes.repoRunRepo.create.mock.calls[0]?.[0]).toMatchObject({
      goal: VALID.goal,
      repo_url: VALID.repo_url,
    });
  });

  it("collapses whitespace and ellipsizes a long goal into an 80-char task title", async () => {
    const fakes = makeFakes();
    const goal = `Extract   every\n  table ${"x".repeat(200)}`;
    await makeTool(fakes).handler({ goal, repo_url: VALID.repo_url });

    const title = fakes.taskRepo.create.mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78); // 77 chars + the single-char ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Extract every table ")).toBe(true);
    // The untruncated goal still reaches description + repo_run.goal.
    expect(fakes.repoRunRepo.create.mock.calls[0]?.[0]).toMatchObject({ goal });
  });

  it("keeps an exactly-80-char goal as the title without ellipsizing", async () => {
    const fakes = makeFakes();
    const goal = "y".repeat(80);
    await makeTool(fakes).handler({ goal, repo_url: VALID.repo_url });

    expect(fakes.taskRepo.create.mock.calls[0]?.[0].title).toBe(goal);
  });
});

describe("use_repo input_url passthrough", () => {
  it("echoes a trimmed input_url and input_filename back to the agent", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("omits both when absent or non-string", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      input_url: 5,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit clamping", () => {
  it("passes sane limits through untouched", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      limits: {
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });

    expect(result.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  // A dropped key means "server default", which is safer than honoring a
  // zero or negative cap that would make the run fail immediately.
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-numeric", "20"],
  ])("drops a %s limit rather than honoring it", async (_label, value) => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({
      ...VALID,
      limits: {
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      },
    });

    expect(result.content.limits).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "fast"],
  ])("treats %s limits as empty", async (_label, limits) => {
    const fakes = makeFakes();
    const result = await makeTool(fakes).handler({ ...VALID, limits });

    expect(result.content.limits).toEqual({});
  });
});

describe("use_repo failure envelopes", () => {
  it("returns dispatch_failed and never inserts repo_run when dispatch throws", async () => {
    const fakes = makeFakes({ dispatchThrows: new Error("daemon offline") });
    const result = await makeTool(fakes).handler(VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "daemon offline",
    });
    expect(fakes.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("returns repo_run_create_failed so the agent does not wait on an orphan session", async () => {
    const fakes = makeFakes({ repoRunThrows: new Error("fk violation") });
    const result = await makeTool(fakes).handler(VALID);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "fk violation",
    });
  });

  it("stringifies a non-Error throw from either step", async () => {
    const dispatchFakes = makeFakes({
      dispatchThrows: "boom" as unknown as Error,
    });
    const dispatchResult = await makeTool(dispatchFakes).handler(VALID);
    expect(dispatchResult.content).toMatchObject({ message: "boom" });

    const repoRunFakes = makeFakes({
      repoRunThrows: { code: 23503 } as unknown as Error,
    });
    const repoRunResult = await makeTool(repoRunFakes).handler(VALID);
    expect(repoRunResult.content).toMatchObject({ message: "[object Object]" });
  });
});
