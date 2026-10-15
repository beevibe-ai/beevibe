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

const AGENT_ID = "agent_caller";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return { id: AGENT_ID, name: "Caller", ...overrides } as unknown as Agent;
}

interface Harness {
  services: UseRepoServices;
  created: { tasks: Array<Record<string, unknown>>; repoRuns: Array<Record<string, unknown>> };
  dispatched: Array<Record<string, unknown>>;
}

function harness(
  opts: {
    agent?: Agent | undefined;
    dispatchError?: Error;
    repoRunError?: Error;
  } = {},
): Harness {
  const created = {
    tasks: [] as Array<Record<string, unknown>>,
    repoRuns: [] as Array<Record<string, unknown>>,
  };
  const dispatched: Array<Record<string, unknown>> = [];

  const agentRepo = {
    findById: vi.fn(async () =>
      "agent" in opts ? opts.agent : fakeAgent(),
    ),
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.tasks.push(input);
      return { ...input, status: "pending" } as unknown as Task;
    }),
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.repoRunError) throw opts.repoRunError;
      created.repoRuns.push(input);
      return input as unknown as RepoRun;
    }),
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: Record<string, unknown>) => {
      if (opts.dispatchError) throw opts.dispatchError;
      dispatched.push(input);
      return { session: { id: input.sessionIdOverride }, runtime_id: null };
    }),
  } as unknown as DispatchService;

  return {
    services: { agentRepo, taskRepo, repoRunRepo, dispatchService },
    created,
    dispatched,
  };
}

function build(h: Harness) {
  return createUseRepoTool({ agentId: AGENT_ID }, h.services);
}

describe("use_repo tool descriptor", () => {
  it("exposes the tool name and the required input fields", () => {
    const tool = build(harness());

    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });

  it("documents find_repo as the discovery companion", () => {
    const tool = build(harness());

    expect(tool.description).toContain("find_repo");
  });
});

describe("use_repo input validation", () => {
  it.each([
    ["missing", {}],
    ["blank", { goal: "   " }],
    ["non-string", { goal: 42 }],
  ])("rejects a %s goal before touching any service", async (_label, input) => {
    const h = harness();
    const result = await build(h).handler({
      repo_url: "https://github.com/acme/tool",
      ...input,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_goal" });
    expect(h.created.tasks).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["http, not https", "http://github.com/acme/tool"],
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    ["a lookalike host", "https://notgithub.com/acme/tool"],
    ["unparseable", "not a url at all"],
    ["blank", "   "],
  ])("rejects a repo_url that is %s", async (_label, repoUrl) => {
    const h = harness();
    const result = await build(h).handler({
      goal: "Extract tables from this PDF",
      ...(repoUrl === undefined ? {} : { repo_url: repoUrl }),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_repo_url" });
    expect(h.created.tasks).toHaveLength(0);
  });

  it.each([
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "https://GitHub.com/acme/tool",
  ])("accepts %s as a GitHub HTTPS url", async (repoUrl) => {
    const h = harness();
    const result = await build(h).handler({ goal: "do the thing", repo_url: repoUrl });

    expect(result.isError).toBeFalsy();
    expect(h.created.repoRuns[0]).toMatchObject({ repo_url: repoUrl });
  });

  it("returns agent_not_found when the caller does not resolve", async () => {
    const h = harness({ agent: undefined });
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "agent_not_found" });
    expect(h.created.tasks).toHaveLength(0);
  });
});

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: "Extract the tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });

    expect(result.isError).toBeFalsy();

    expect(h.created.tasks).toHaveLength(1);
    expect(h.created.tasks[0]).toMatchObject({
      title: "Extract the tables from this PDF as JSON",
      description: "Extract the tables from this PDF as JSON",
      priority: "medium",
      assignee_id: AGENT_ID,
      creator_id: AGENT_ID,
      creator_type: "agent",
    });

    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      agentId: AGENT_ID,
      type: "run_repo",
      intent: "Extract the tables from this PDF as JSON",
      reason: { kind: "fresh" },
    });

    expect(h.created.repoRuns).toHaveLength(1);
    expect(h.created.repoRuns[0]).toMatchObject({
      agent_id: AGENT_ID,
      goal: "Extract the tables from this PDF as JSON",
      repo_url: "https://github.com/jsvine/pdfplumber",
      status: "pending",
    });

    expect(result.content).toMatchObject({
      status: "pending",
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
    expect(result.content.watch_url).toBe(
      `/capabilities/runs/${result.content.repo_run_id as string}`,
    );
  });

  it("pre-mints the session id and reuses it for dispatch, repo_run and the reply", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    const sessionId = result.content.session_id as string;
    expect(sessionId).toBeTruthy();
    // The repo_run FK needs the session row to exist first, so the id is
    // minted up front and threaded through as sessionIdOverride.
    expect(h.dispatched[0]?.sessionIdOverride).toBe(sessionId);
    expect(h.created.repoRuns[0]?.session_id).toBe(sessionId);
  });

  it("ties the repo_run and the reply to the container task it just created", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    const taskId = h.created.tasks[0]?.id;
    expect(taskId).toBeTruthy();
    expect(h.created.repoRuns[0]?.task_id).toBe(taskId);
    expect(result.content.task_id).toBe(taskId);
    expect((h.dispatched[0]?.task as Task | undefined)?.id).toBe(taskId);
  });

  it("trims the goal and collapses whitespace in the container task title", async () => {
    const h = harness();
    await build(h).handler({
      goal: "  Extract\n\n  the   tables  ",
      repo_url: "https://github.com/acme/tool",
    });

    expect(h.created.tasks[0]?.title).toBe("Extract the tables");
    // Only the title is collapsed; the description keeps the goal as typed.
    expect(h.created.tasks[0]?.description).toBe("Extract\n\n  the   tables");
  });

  it("truncates a long goal to an 80-char title with an ellipsis", async () => {
    const h = harness();
    const goal = "x".repeat(200);
    await build(h).handler({ goal, repo_url: "https://github.com/acme/tool" });

    const title = h.created.tasks[0]?.title as string;
    expect(title).toBe("x".repeat(77) + "…");
    // The description keeps the full goal — only the inbox row is clipped.
    expect(h.created.tasks[0]?.description).toBe(goal);
  });

  it("keeps an exactly-80-char goal intact as the title", async () => {
    const h = harness();
    const goal = "y".repeat(80);
    await build(h).handler({ goal, repo_url: "https://github.com/acme/tool" });

    expect(h.created.tasks[0]?.title).toBe(goal);
  });

  it("omits input_url / input_filename when they are not strings", async () => {
    const h = harness();
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
      input_url: 7,
      input_filename: null,
    });

    expect(result.content.input_url).toBeUndefined();
    expect(result.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limit parsing", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const h = harness();
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
      limits,
    });
    return result.content.limits as Record<string, unknown>;
  }

  it("passes through in-range limits", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 999,
        max_install_attempts: 99,
        disk_mb: 1_000_000,
      }),
    ).toEqual({ wall_clock_minutes: 60, max_install_attempts: 5, disk_mb: 10_000 });
  });

  it("floors fractional attempt and disk limits but not the wall clock", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 1.5, max_install_attempts: 2.9, disk_mb: 100.7 }),
    ).toEqual({ wall_clock_minutes: 1.5, max_install_attempts: 2, disk_mb: 100 });
  });

  it.each([
    ["zero", { wall_clock_minutes: 0, max_install_attempts: 0, disk_mb: 0 }],
    ["negative", { wall_clock_minutes: -5, max_install_attempts: -1, disk_mb: -10 }],
    ["non-numeric", { wall_clock_minutes: "20", max_install_attempts: null, disk_mb: {} }],
  ])("drops %s limits rather than passing them on", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a scalar", "none"],
  ])("returns an empty limits object when limits is %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const h = harness({ dispatchError: new Error("no daemon online") });
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(h.created.repoRuns).toHaveLength(0);
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const h = harness();
    h.services.dispatchService.dispatchTask = vi.fn(async () => {
      throw "boom";
    }) as unknown as DispatchService["dispatchTask"];

    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.content).toMatchObject({
      error: "dispatch_failed",
      message: "boom",
    });
  });

  it("surfaces repo_run_create_failed so the agent does not wait on an orphan session", async () => {
    const h = harness({ repoRunError: new Error("duplicate key") });
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already dispatched; it self-recovers as failed.
    expect(h.dispatched).toHaveLength(1);
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const h = harness({ repoRunError: "pg exploded" as unknown as Error });
    const result = await build(h).handler({
      goal: "do the thing",
      repo_url: "https://github.com/acme/tool",
    });

    expect(result.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "pg exploded",
    });
  });
});
