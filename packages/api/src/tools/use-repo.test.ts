/**
 * use_repo tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is a plain closure over (ctx, services), so everything
 * interesting is reachable without a sandbox: input validation, the
 * `limits` clamp, the container-task title cut, and the two-step
 * dispatch → repo_run insert whose ORDER is load-bearing (repo_run
 * has an FK to session.id, which only exists once dispatch has run).
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
import type { AgentToolResult } from "./types.js";

const AGENT_ID = "agent_caller";
const REPO_URL = "https://github.com/acme/pdfplumber";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Caller",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Harness {
  handler: (input: Record<string, unknown>) => Promise<AgentToolResult>;
  agentFindById: ReturnType<typeof vi.fn>;
  taskCreate: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  repoRunCreate: ReturnType<typeof vi.fn>;
  /** Call order across the three writing collaborators. */
  calls: string[];
}

/** First argument of a mock's first call, as a readable bag of fields. */
function firstArg(mock: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  return mock.mock.calls[0]![0] as Record<string, unknown>;
}

function makeTool(
  overrides: {
    agent?: Agent | undefined;
    dispatchTask?: ReturnType<typeof vi.fn>;
    repoRunCreate?: ReturnType<typeof vi.fn>;
  } = {},
): Harness {
  const calls: string[] = [];
  const agent = "agent" in overrides ? overrides.agent : fakeAgent();

  const agentFindById = vi.fn(async () => agent);
  const taskCreate = vi.fn(async (input: Partial<Task>) => {
    calls.push("task.create");
    return { ...input, status: "assigned" } as Task;
  });
  const dispatchTask =
    overrides.dispatchTask ??
    vi.fn(async () => {
      calls.push("dispatch");
      return { sessionId: "sess_x" };
    });
  const repoRunCreate =
    overrides.repoRunCreate ??
    vi.fn(async (input: Partial<RepoRun>) => {
      calls.push("repoRun.create");
      return input as RepoRun;
    });

  const tool = createUseRepoTool(
    { agentId: AGENT_ID },
    {
      agentRepo: { findById: agentFindById } as unknown as AgentRepository,
      taskRepo: { create: taskCreate } as unknown as TaskRepository,
      repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
      dispatchService: {
        dispatchTask,
      } as unknown as DispatchService,
    },
  );

  return {
    handler: tool.handler,
    agentFindById,
    taskCreate,
    dispatchTask,
    repoRunCreate,
    calls,
  };
}

describe("use_repo — tool shape", () => {
  it("declares goal + repo_url as the required inputs", () => {
    const tool = createUseRepoTool({ agentId: AGENT_ID }, {
      agentRepo: {} as AgentRepository,
      taskRepo: {} as TaskRepository,
      repoRunRepo: {} as RepoRunRepository,
      dispatchService: {} as DispatchService,
    });
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo — input validation", () => {
  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
  ])("rejects a goal that is %s", async (_label, goal) => {
    const { handler, agentFindById } = makeTool();
    const res = await handler({ goal, repo_url: REPO_URL });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    // Validation short-circuits before any repo is touched.
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["not a string", 7],
    ["not a URL at all", "acme/pdfplumber"],
    ["plain http", "http://github.com/acme/pdfplumber"],
    ["a different host", "https://gitlab.com/acme/pdfplumber"],
    ["a lookalike host", "https://evilgithub.com/acme/pdfplumber"],
    ["ssh", "git@github.com:acme/pdfplumber.git"],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const { handler, agentFindById } = makeTool();
    const res = await handler({ goal: "extract tables", repo_url: repoUrl });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(agentFindById).not.toHaveBeenCalled();
  });

  it.each([
    ["apex github.com", "https://github.com/acme/pdfplumber"],
    ["a www subdomain", "https://www.github.com/acme/pdfplumber"],
    ["mixed case host", "https://GitHub.com/acme/pdfplumber"],
  ])("accepts %s", async (_label, repoUrl) => {
    const { handler } = makeTool();
    const res = await handler({ goal: "extract tables", repo_url: repoUrl });
    expect(res.isError).toBeUndefined();
  });

  it("trims surrounding whitespace off goal and repo_url", async () => {
    const { handler, taskCreate, repoRunCreate } = makeTool();
    await handler({ goal: "  extract tables  ", repo_url: `  ${REPO_URL}  ` });
    expect(firstArg(taskCreate).description).toBe("extract tables");
    expect(firstArg(repoRunCreate).repo_url).toBe(REPO_URL);
  });

  it("404s when the calling agent no longer exists", async () => {
    const { handler, taskCreate } = makeTool({ agent: undefined });
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("use_repo — container task", () => {
  it("pins creator and assignee to the calling agent", async () => {
    const { handler, taskCreate } = makeTool();
    await handler({ goal: "extract tables", repo_url: REPO_URL });
    expect(taskCreate).toHaveBeenCalledTimes(1);
    expect(firstArg(taskCreate)).toMatchObject({
      title: "extract tables",
      description: "extract tables",
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });
  });

  it("collapses runs of whitespace in the title", async () => {
    const { handler, taskCreate } = makeTool();
    const goal = "extract\n  tables\tfrom\nthe PDF";
    await handler({ goal, repo_url: REPO_URL });
    expect(firstArg(taskCreate).title).toBe("extract tables from the PDF");
    // The full goal survives on description even when the title is reshaped.
    expect(firstArg(taskCreate).description).toBe(goal);
  });

  it("keeps an exactly-80-char title intact", async () => {
    const { handler, taskCreate } = makeTool();
    const goal = "x".repeat(80);
    await handler({ goal, repo_url: REPO_URL });
    expect(firstArg(taskCreate).title).toBe(goal);
  });

  it("truncates a longer title to 77 chars plus an ellipsis", async () => {
    const { handler, taskCreate } = makeTool();
    await handler({ goal: "y".repeat(81), repo_url: REPO_URL });
    const title = firstArg(taskCreate).title as string;
    expect(title).toBe("y".repeat(77) + "…");
    expect(title).toHaveLength(78);
  });
});

describe("use_repo — dispatch then repo_run", () => {
  it("dispatches a run_repo session under a pre-minted session id", async () => {
    const { handler, dispatchTask, taskCreate } = makeTool();
    await handler({ goal: "extract tables", repo_url: REPO_URL });

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const arg = firstArg(dispatchTask);
    expect(arg).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: "extract tables",
      reason: { kind: "fresh" },
    });
    expect(arg.task).toBe(await taskCreate.mock.results[0]!.value);
    expect(typeof arg.sessionIdOverride).toBe("string");
  });

  it("creates the repo_run only after dispatch, with the same session id", async () => {
    const { handler, dispatchTask, repoRunCreate, calls } = makeTool();
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });

    // repo_run.session_id has an FK to session.id, which dispatch creates.
    expect(calls).toEqual(["task.create", "dispatch", "repoRun.create"]);

    const sessionId = firstArg(dispatchTask).sessionIdOverride;
    expect(firstArg(repoRunCreate)).toMatchObject({
      session_id: sessionId,
      agent_id: AGENT_ID,
      goal: "extract tables",
      repo_url: REPO_URL,
      status: "pending",
    });
    expect(res.content.session_id).toBe(sessionId);
  });

  it("returns the ids, a pending status and the watch url", async () => {
    const { handler, repoRunCreate } = makeTool();
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });

    const created = firstArg(repoRunCreate);
    const repoRunId = created.id as string;
    const taskId = created.task_id as string;
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatchObject({
      repo_run_id: repoRunId,
      task_id: taskId,
      status: "pending",
      watch_url: `/capabilities/runs/${repoRunId}`,
    });
    expect(res.content.note).toContain("Sandbox run started");
  });

  it("mints a fresh session and repo_run id per call", async () => {
    const { handler } = makeTool();
    const a = await handler({ goal: "one", repo_url: REPO_URL });
    const b = await handler({ goal: "two", repo_url: REPO_URL });
    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
  });
});

describe("use_repo — failure envelopes", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const dispatchTask = vi.fn(async () => {
      throw new Error("no daemon online");
    });
    const { handler, repoRunCreate } = makeTool({ dispatchTask });
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(repoRunCreate).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error thrown out of dispatch", async () => {
    const dispatchTask = vi.fn(async () => {
      throw "boom";
    });
    const { handler } = makeTool({ dispatchTask });
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });
    expect(res.content.message).toBe("boom");
  });

  it("reports repo_run_create_failed when the insert loses the race", async () => {
    const repoRunCreate = vi.fn(async () => {
      throw new Error("duplicate key");
    });
    const { handler } = makeTool({ repoRunCreate });
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error thrown out of the repo_run insert", async () => {
    const repoRunCreate = vi.fn(async () => {
      throw { code: "23505" };
    });
    const { handler } = makeTool({ repoRunCreate });
    const res = await handler({ goal: "extract tables", repo_url: REPO_URL });
    expect(res.content.message).toBe("[object Object]");
  });
});

describe("use_repo — optional input file", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const { handler } = makeTool();
    const res = await handler({
      goal: "extract tables",
      repo_url: REPO_URL,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(res.content.input_url).toBe("https://example.com/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves both undefined when they are absent or the wrong type", async () => {
    const { handler } = makeTool();
    const res = await handler({
      goal: "extract tables",
      repo_url: REPO_URL,
      input_filename: 5,
    });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — limits clamp", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const { handler } = makeTool();
    const res = await handler({
      goal: "extract tables",
      repo_url: REPO_URL,
      limits,
    });
    return res.content.limits as Record<string, unknown>;
  }

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a string", "20"],
    ["a number", 20],
  ])("returns an empty object when limits is %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it("passes through in-range values untouched", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 10,
        max_install_attempts: 3,
        disk_mb: 512,
      }),
    ).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("caps each value at its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 50,
        disk_mb: 1_000_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors the integer-valued limits but not the wall clock", async () => {
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
  ])("drops a %s limit rather than clamping it", async (_label, value) => {
    expect(
      await limitsFor({
        wall_clock_minutes: value,
        max_install_attempts: value,
        disk_mb: value,
      }),
    ).toEqual({});
  });
});
