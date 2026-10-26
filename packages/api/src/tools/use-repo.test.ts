import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  NewRepoRun,
  NewTask,
  RepoRunRepository,
  RepoRun,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type {
  DispatchInput,
  DispatchResult,
  DispatchService,
} from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool } from "./use-repo.js";

const AGENT = { id: "agent_a", name: "Ada" } as unknown as Agent;

function harness(overrides: { agent?: Agent | null } = {}) {
  const findById = vi.fn(async (_id: string): Promise<Agent | null> =>
    overrides.agent === undefined ? AGENT : overrides.agent,
  );
  const createTask = vi.fn(
    async (t: NewTask): Promise<Task> =>
      ({ ...t, status: "pending" }) as unknown as Task,
  );
  const dispatchTask = vi.fn(
    async (_input: DispatchInput): Promise<DispatchResult> =>
      ({}) as unknown as DispatchResult,
  );
  const createRepoRun = vi.fn(
    async (r: NewRepoRun): Promise<RepoRun> => r as unknown as RepoRun,
  );

  const tool = createUseRepoTool(
    { agentId: "agent_a" },
    {
      agentRepo: { findById } as unknown as AgentRepository,
      taskRepo: { create: createTask } as unknown as TaskRepository,
      repoRunRepo: { create: createRepoRun } as unknown as RepoRunRepository,
      dispatchService: { dispatchTask } as unknown as DispatchService,
    },
  );

  return { tool, findById, createTask, dispatchTask, createRepoRun };
}

function firstArg<A extends unknown[]>(mock: { mock: { calls: A[] } }): A[0] {
  const call = mock.mock.calls[0];
  if (!call) throw new Error("expected the mock to have been called");
  return call[0];
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/acme/pdf-tables",
};

describe("use_repo tool descriptor", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { tool } = harness();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });

  it("rejects unknown top-level properties", () => {
    const { tool } = harness();
    expect(tool.schema.additionalProperties).toBe(false);
  });
});

describe("use_repo happy path", () => {
  it("returns freshly minted ids, pending status and a watch url", async () => {
    const { tool, createRepoRun } = harness();

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ status: "pending" });
    expect(result.content.repo_run_id).toMatch(/^repo_/);
    expect(result.content.session_id).toMatch(/^sess_/);
    expect(result.content.task_id).toMatch(/^task_/);
    expect(result.content.watch_url).toBe(
      `/capabilities/runs/${result.content.repo_run_id as string}`,
    );
    expect(createRepoRun).toHaveBeenCalledTimes(1);
  });

  it("pins the container task to the looked-up agent as both creator and assignee", async () => {
    const { tool, createTask, findById } = harness();

    await tool.handler(OK_INPUT);

    expect(findById).toHaveBeenCalledWith("agent_a");
    expect(firstArg(createTask)).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const { tool, dispatchTask, createTask } = harness();

    const result = await tool.handler(OK_INPUT);

    const dispatched = firstArg(dispatchTask);
    expect(dispatched).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: OK_INPUT.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: result.content.session_id,
    });
    // The container task row, not a copy — repo_run.task_id has to match.
    expect(dispatched.task).toBe(await createTask.mock.results[0]?.value);
  });

  // repo_run.session_id has an FK to session.id, so dispatch (which inserts
  // the session) must land before the repo_run insert.
  it("creates the session via dispatch before inserting the repo_run", async () => {
    const order: string[] = [];
    const { tool, dispatchTask, createRepoRun, createTask } = harness();
    createTask.mockImplementationOnce(async (t: NewTask) => {
      order.push("task");
      return { ...t } as unknown as Task;
    });
    dispatchTask.mockImplementationOnce(async () => {
      order.push("dispatch");
      return {} as unknown as DispatchResult;
    });
    createRepoRun.mockImplementationOnce(async (r: NewRepoRun) => {
      order.push("repo_run");
      return r as unknown as RepoRun;
    });

    await tool.handler(OK_INPUT);

    expect(order).toEqual(["task", "dispatch", "repo_run"]);
  });

  it("writes the repo_run row with the goal, url and linked ids", async () => {
    const { tool, createRepoRun } = harness();

    const result = await tool.handler(OK_INPUT);

    expect(firstArg(createRepoRun)).toEqual({
      id: result.content.repo_run_id,
      session_id: result.content.session_id,
      task_id: result.content.task_id,
      agent_id: "agent_a",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("trims the goal and repo_url", async () => {
    const { tool, createRepoRun } = harness();

    await tool.handler({
      goal: "  Download the audio track  ",
      repo_url: "  https://github.com/acme/dl  ",
    });

    expect(firstArg(createRepoRun)).toMatchObject({
      goal: "Download the audio track",
      repo_url: "https://github.com/acme/dl",
    });
  });

  it("echoes trimmed input_url and input_filename", async () => {
    const { tool } = harness();

    const result = await tool.handler({
      ...OK_INPUT,
      input_url: "  https://files.example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(result.content).toMatchObject({
      input_url: "https://files.example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves input_url and input_filename undefined when absent or non-strings", async () => {
    const { tool } = harness();

    const bare = await tool.handler(OK_INPUT);
    expect(bare.content.input_url).toBeUndefined();
    expect(bare.content.input_filename).toBeUndefined();

    const wrongTypes = await tool.handler({
      ...OK_INPUT,
      input_url: 7,
      input_filename: null,
    });
    expect(wrongTypes.content.input_url).toBeUndefined();
    expect(wrongTypes.content.input_filename).toBeUndefined();
  });
});

describe("use_repo container task title", () => {
  it("collapses whitespace so the inbox row stays scannable", async () => {
    const { tool, createTask } = harness();
    await tool.handler({ ...OK_INPUT, goal: "Extract\n\tthe   tables" });
    expect(firstArg(createTask).title).toBe("Extract the tables");
  });

  it("keeps a title of exactly 80 characters intact", async () => {
    const { tool, createTask } = harness();
    const goal = "x".repeat(80);
    await tool.handler({ ...OK_INPUT, goal });
    expect(firstArg(createTask).title).toBe(goal);
  });

  it("truncates a longer title to 77 characters plus an ellipsis", async () => {
    const { tool, createTask } = harness();
    const goal = "y".repeat(200);
    await tool.handler({ ...OK_INPUT, goal });
    const title = firstArg(createTask).title;
    expect(title).toBe("y".repeat(77) + "…");
    expect(title).toHaveLength(78);
  });

  it("truncates the title but keeps the full goal as the description", async () => {
    const { tool, createTask } = harness();
    const goal = "z".repeat(200);
    await tool.handler({ ...OK_INPUT, goal });
    expect(firstArg(createTask).description).toBe(goal);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing, blank or non-string goal before touching any repo", async () => {
    const { tool, findById, createTask } = harness();

    for (const goal of [undefined, "", "   ", 7]) {
      const result = await tool.handler({ ...OK_INPUT, goal });
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_goal" });
    }
    expect(findById).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects a non-GitHub, non-HTTPS or unparseable repo_url", async () => {
    const { tool, createTask } = harness();

    const bad = [
      undefined,
      "",
      "   ",
      42,
      "http://github.com/acme/repo", // not https
      "https://gitlab.com/acme/repo", // wrong host
      "https://notgithub.com/acme/repo", // suffix must be a label boundary
      "https://github.com.evil.test/acme/repo", // host is not github.com
      "not a url at all",
      "git@github.com:acme/repo.git", // ssh form
    ];

    for (const repo_url of bad) {
      const result = await tool.handler({ ...OK_INPUT, repo_url });
      expect(result.isError, `expected ${String(repo_url)} to be rejected`).toBe(true);
      expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    }
    expect(createTask).not.toHaveBeenCalled();
  });

  it("accepts github.com and its subdomains, case-insensitively", async () => {
    for (const repo_url of [
      "https://github.com/acme/repo",
      "https://www.github.com/acme/repo",
      "https://GitHub.com/acme/repo",
    ]) {
      const { tool } = harness();
      const result = await tool.handler({ ...OK_INPUT, repo_url });
      expect(result.isError, `expected ${repo_url} to be accepted`).toBeFalsy();
    }
  });

  it("reports the goal problem first when both goal and repo_url are bad", async () => {
    const { tool } = harness();
    const result = await tool.handler({ goal: "", repo_url: "nope" });
    expect(result.content).toMatchObject({ error: "invalid_goal" });
  });
});

describe("use_repo limits", () => {
  it("passes through in-range limits", async () => {
    const { tool } = harness();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: { wall_clock_minutes: 15, max_install_attempts: 3, disk_mb: 1024 },
    });
    expect(result.content.limits).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    const { tool } = harness();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: {
        wall_clock_minutes: 600,
        max_install_attempts: 50,
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
    const { tool } = harness();
    const result = await tool.handler({
      ...OK_INPUT,
      limits: { max_install_attempts: 2.9, disk_mb: 512.7 },
    });
    expect(result.content.limits).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric limits so the defaults apply", async () => {
    const { tool } = harness();
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

  it("treats a missing or non-object limits block as empty", async () => {
    const { tool } = harness();

    for (const limits of [undefined, null, "fast", 7]) {
      const result = await tool.handler({ ...OK_INPUT, limits });
      expect(result.content.limits).toEqual({});
    }
  });
});

describe("use_repo failure paths", () => {
  it("reports agent_not_found and creates nothing when the caller is unknown", async () => {
    const { tool, createTask, dispatchTask } = harness({ agent: null });

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(createTask).not.toHaveBeenCalled();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { tool, dispatchTask, createRepoRun } = harness();
    dispatchTask.mockRejectedValueOnce(new Error("no runtime online"));

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(createRepoRun).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const { tool, dispatchTask } = harness();
    dispatchTask.mockRejectedValueOnce("ECONNRESET");

    const result = await tool.handler(OK_INPUT);

    expect(result.content).toEqual({
      error: "dispatch_failed",
      message: "ECONNRESET",
    });
  });

  // The session row has already landed here. The run self-recovers (the
  // daemon finds no repo_run and fails the session), but the agent must be
  // told rather than left polling a run that will never start.
  it("reports repo_run_create_failed when the insert fails after dispatch", async () => {
    const { tool, createRepoRun } = harness();
    createRepoRun.mockRejectedValueOnce(new Error("duplicate key"));

    const result = await tool.handler(OK_INPUT);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const { tool, createRepoRun } = harness();
    createRepoRun.mockRejectedValueOnce({ code: "23505" });

    const result = await tool.handler(OK_INPUT);

    expect(result.content).toMatchObject({ error: "repo_run_create_failed" });
    expect(result.content.message).toBe("[object Object]");
  });
});
