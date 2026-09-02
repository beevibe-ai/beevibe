import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

const AGENT = { id: "agent_a", name: "Ada" } as unknown as Agent;

interface Fakes {
  findById: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  createRepoRun: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<Fakes> = {}) {
  const findById = overrides.findById ?? vi.fn(async () => AGENT);
  const createTask =
    overrides.createTask ??
    vi.fn(async (row: Record<string, unknown>) => row as unknown as Task);
  const createRepoRun = overrides.createRepoRun ?? vi.fn(async () => undefined);
  const dispatchTask = overrides.dispatchTask ?? vi.fn(async () => ({}));

  const tool = createUseRepoTool(
    { agentId: "agent_a" },
    {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: createTask } as unknown as TaskRepository,
      repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
      dispatchService: { dispatchTask } as unknown as DispatchService,
    },
  );
  return { tool, findById, createTask, createRepoRun, dispatchTask };
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

describe("use_repo tool definition", () => {
  it("requires goal and repo_url and forbids extra properties", () => {
    const { tool } = build();

    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, blank, or non-string goal", async () => {
    const { tool, createTask } = build();

    for (const goal of [undefined, "", "   ", 7]) {
      const result = await tool.handler({ ...OK_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["http://github.com/a/b", "not https"],
    ["https://gitlab.com/a/b", "not github"],
    ["https://notgithub.com/a/b", "github only as a suffix of another word"],
    ["not a url at all", "unparseable"],
    ["", "empty"],
  ])("rejects repo_url %s (%s)", async (repoUrl) => {
    const { tool, createTask } = build();

    const result = await tool.handler({ ...OK_INPUT, repo_url: repoUrl });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("accepts a github.com subdomain", async () => {
    const { tool } = build();

    const result = await tool.handler({
      ...OK_INPUT,
      repo_url: "https://www.github.com/jsvine/pdfplumber",
    });

    expect(result.isError).toBeFalsy();
  });

  it("rejects the call when the calling agent no longer exists", async () => {
    const { tool, createTask } = build({ findById: vi.fn(async () => null) });

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("creates the container task assigned to and created by the caller", async () => {
    const { tool, createTask } = build();

    await tool.handler(OK_INPUT);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("collapses whitespace and truncates a long goal into the task title", async () => {
    const { tool, createTask } = build();
    const goal = `${"word ".repeat(40)}end`;

    await tool.handler({ ...OK_INPUT, goal });

    const title = createTask.mock.calls[0]?.[0].title as string;
    expect(title).toHaveLength(78); // 77 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s\s/);
  });

  it("keeps a short goal as the title untouched", async () => {
    const { tool, createTask } = build();

    await tool.handler({ ...OK_INPUT, goal: "  Extract   tables  " });

    expect(createTask.mock.calls[0]?.[0].title).toBe("Extract tables");
  });

  it("dispatches under a pre-minted session id, then inserts the repo_run against it", async () => {
    const { tool, dispatchTask, createRepoRun, createTask } = build();

    const result = await tool.handler(OK_INPUT);

    const dispatched = dispatchTask.mock.calls[0]?.[0];
    const repoRun = createRepoRun.mock.calls[0]?.[0];
    const task = createTask.mock.calls[0]?.[0];

    expect(dispatched).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: OK_INPUT.goal,
      task,
      reason: { kind: "fresh" },
    });
    // repo_run.session_id has an FK to session.id, so the dispatch that
    // creates the session row must use the same id the repo_run points at.
    expect(repoRun.session_id).toBe(dispatched.sessionIdOverride);
    expect(repoRun).toMatchObject({
      task_id: task.id,
      agent_id: "agent_a",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
    expect(result.content).toMatchObject({
      repo_run_id: repoRun.id,
      session_id: repoRun.session_id,
      task_id: task.id,
      status: "pending",
      watch_url: `/capabilities/runs/${repoRun.id}`,
    });
  });

  it("dispatches before inserting the repo_run", async () => {
    const order: string[] = [];
    const { tool } = build({
      dispatchTask: vi.fn(async () => {
        order.push("dispatch");
        return {};
      }),
      createRepoRun: vi.fn(async () => {
        order.push("repo_run");
      }),
    });

    await tool.handler(OK_INPUT);

    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("trims goal and repo_url before persisting them", async () => {
    const { tool, createRepoRun } = build();

    await tool.handler({
      goal: "  Extract tables  ",
      repo_url: "  https://github.com/jsvine/pdfplumber  ",
    });

    expect(createRepoRun.mock.calls[0]?.[0]).toMatchObject({
      goal: "Extract tables",
      repo_url: "https://github.com/jsvine/pdfplumber",
    });
  });

  it("echoes trimmed input_url and input_filename back to the agent", async () => {
    const { tool } = build();

    const result = await tool.handler({
      ...OK_INPUT,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves input_url and input_filename undefined when not strings", async () => {
    const { tool } = build();

    const result = await tool.handler({ ...OK_INPUT, input_url: 1, input_filename: {} });

    expect(result.content).toMatchObject({
      input_url: undefined,
      input_filename: undefined,
    });
  });

  it("mints a distinct repo_run, session and task id per call", async () => {
    const { tool } = build();

    const a = (await tool.handler(OK_INPUT)).content;
    const b = (await tool.handler(OK_INPUT)).content;

    expect(a.repo_run_id).not.toBe(b.repo_run_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.task_id).not.toBe(b.task_id);
  });
});

describe("use_repo limit parsing", () => {
  it("passes through in-range limits, flooring the integer ones", async () => {
    const { tool } = build();

    const result = await tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3.7, disk_mb: 1024.9 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const { tool } = build();

    const result = await tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 999, max_install_attempts: 99, disk_mb: 999_999 },
    });

    expect(result.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("drops non-positive and non-numeric limits", async () => {
    const { tool } = build();

    const result = await tool.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      },
    });

    expect(result.content.limits).toEqual({});
  });

  it("returns empty limits when the field is absent or not an object", async () => {
    const { tool } = build();

    for (const limits of [undefined, null, "big", 5]) {
      const result = await tool.handler({ ...OK_INPUT, limits });
      expect(result.content.limits).toEqual({});
    }
  });
});

describe("use_repo failure paths", () => {
  it("reports dispatch_failed without inserting a repo_run", async () => {
    const { tool, createRepoRun } = build({
      dispatchTask: vi.fn(async () => {
        throw new Error("no runtime online");
      }),
    });

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(createRepoRun).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed when the insert loses the race", async () => {
    const { tool } = build({
      createRepoRun: vi.fn(async () => {
        throw new Error("duplicate key");
      }),
    });

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies non-Error throws from either write", async () => {
    const dispatchFail = build({
      dispatchTask: vi.fn(async () => {
        throw "boom";
      }),
    });
    expect((await dispatchFail.tool.handler(OK_INPUT)).content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });

    const repoRunFail = build({
      createRepoRun: vi.fn(async () => {
        throw "bang";
      }),
    });
    expect((await repoRunFail.tool.handler(OK_INPUT)).content).toMatchObject({
      error: "repo_run_create_failed",
      message: "bang",
    });
  });
});
