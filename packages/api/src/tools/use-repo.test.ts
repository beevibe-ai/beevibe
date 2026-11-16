/**
 * use_repo — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is an orchestration sequence with a specific, load-bearing
 * order: validate → resolve agent → create container task → dispatch
 * (which creates the session row) → insert repo_run. The FK from
 * repo_run.session_id to session.id is why dispatch has to precede the
 * repo_run insert, so these tests pin the ordering as well as the
 * per-step failure envelopes.
 *
 * Also covered: the two pure helpers reached only through the handler —
 * `isLikelyGithubUrl` (the host allowlist) and `parseLimits` (the limit
 * clamps that stop an agent requesting a 10-hour run).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentRepository,
  RepoRun,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

// ── Fakes ────────────────────────────────────────────────────────────────

const AGENT = { id: "agent_a", name: "A" };

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_generated",
    title: "Extract tables",
    status: "todo",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-05-01"),
    updated_at: new Date("2026-05-01"),
    ...overrides,
  } as Task;
}

function buildServices(
  overrides: {
    findById?: AgentRepository["findById"];
    taskCreate?: TaskRepository["create"];
    dispatchTask?: DispatchService["dispatchTask"];
    repoRunCreate?: RepoRunRepository["create"];
  } = {},
) {
  const calls: string[] = [];

  const findById =
    overrides.findById ??
    (vi.fn(async () => AGENT) as unknown as AgentRepository["findById"]);

  const taskCreate =
    overrides.taskCreate ??
    (vi.fn(async (input: { id: string; title: string }) => {
      calls.push("task.create");
      return fakeTask({ id: input.id, title: input.title });
    }) as unknown as TaskRepository["create"]);

  const dispatchTask =
    overrides.dispatchTask ??
    (vi.fn(async () => {
      calls.push("dispatch");
      return {} as never;
    }) as unknown as DispatchService["dispatchTask"]);

  const repoRunCreate =
    overrides.repoRunCreate ??
    (vi.fn(async (input: Record<string, unknown>) => {
      calls.push("repoRun.create");
      return input as unknown as RepoRun;
    }) as unknown as RepoRunRepository["create"]);

  const services = {
    agentRepo: { findById } as unknown as AgentRepository,
    taskRepo: { create: taskCreate } as unknown as TaskRepository,
    repoRunRepo: { create: repoRunCreate } as unknown as RepoRunRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
  } satisfies UseRepoServices;

  return { services, calls, findById, taskCreate, dispatchTask, repoRunCreate };
}

function tool(services = buildServices().services) {
  return createUseRepoTool({ agentId: "agent_a" }, services);
}

/** The `n`th call's first argument, typed. `noUncheckedIndexedAccess`
 *  makes a bare `mock.calls[n][0]` possibly-undefined. */
function firstArg<T>(fn: unknown, n = 0): T {
  const args = (fn as { mock: { calls: unknown[][] } }).mock.calls[n];
  if (!args) throw new Error(`expected at least ${n + 1} call(s)`);
  return args[0] as T;
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

// ── Shape ────────────────────────────────────────────────────────────────

describe("createUseRepoTool", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const t = tool();
    expect(t.name).toBe("use_repo");
    const schema = t.schema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["goal", "repo_url"]);
    // Closed schema: an agent passing a stray key should be told, not
    // silently ignored.
    expect(schema.additionalProperties).toBe(false);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("use_repo happy path", () => {
  it("returns the run ids, a watch url and pending status", async () => {
    const { services, repoRunCreate } = buildServices();
    const res = await tool(services).handler(OK_INPUT);

    expect(res.isError).toBeUndefined();
    const c = res.content as Record<string, string>;
    expect(c.status).toBe("pending");
    expect(c.repo_run_id).toMatch(/^repo_/);
    expect(c.session_id).toMatch(/^sess_/);
    expect(c.task_id).toMatch(/^task_/);
    // The watch url has to embed the same id the agent was handed, or the
    // UI link in the response points at nothing.
    expect(c.watch_url).toBe(`/capabilities/runs/${c.repo_run_id}`);

    const run = firstArg<Record<string, unknown>>(repoRunCreate, 0);
    expect(run).toMatchObject({
      id: c.repo_run_id,
      session_id: c.session_id,
      task_id: c.task_id,
      agent_id: "agent_a",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("creates the session row before the repo_run that FKs to it", async () => {
    const { services, calls } = buildServices();
    await tool(services).handler(OK_INPUT);
    // Ordering is the whole reason the handler is written this way:
    // repo_run.session_id has an FK to session.id, and dispatchTask is
    // what inserts the session.
    expect(calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("dispatches a run_repo session carrying the goal as the intent", async () => {
    const { services, dispatchTask } = buildServices();
    const res = await tool(services).handler(OK_INPUT);

    const arg = firstArg<Record<string, unknown>>(dispatchTask, 0);
    expect(arg).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: OK_INPUT.goal,
      reason: { kind: "fresh" },
      sessionIdOverride: (res.content as Record<string, string>).session_id,
    });
    expect((arg.task as Task).id).toBe(
      (res.content as Record<string, string>).task_id,
    );
  });

  it("pins the container task to the agent and uses the goal as description", async () => {
    const { services, taskCreate } = buildServices();
    await tool(services).handler(OK_INPUT);
    const arg = firstArg<Record<string, unknown>>(taskCreate, 0);
    expect(arg).toMatchObject({
      title: OK_INPUT.goal,
      description: OK_INPUT.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });
  });

  it("trims goal and repo_url before use", async () => {
    const { services, repoRunCreate } = buildServices();
    await tool(services).handler({
      goal: "  do the thing  ",
      repo_url: "  https://github.com/o/r  ",
    });
    expect(firstArg<Record<string, unknown>>(repoRunCreate, 0)).toMatchObject({
      goal: "do the thing",
      repo_url: "https://github.com/o/r",
    });
  });

  it("echoes optional input_url / input_filename, trimmed", async () => {
    const { services } = buildServices();
    const res = await tool(services).handler({
      ...OK_INPUT,
      input_url: "  https://example.com/a.pdf  ",
      input_filename: "  a.pdf  ",
    });
    expect(res.content).toMatchObject({
      input_url: "https://example.com/a.pdf",
      input_filename: "a.pdf",
    });
  });

  it("leaves input_url / input_filename undefined when absent or mistyped", async () => {
    const { services } = buildServices();
    const res = await tool(services).handler({ ...OK_INPUT, input_url: 5 });
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

// ── Container task title ─────────────────────────────────────────────────

describe("container task title", () => {
  it("collapses whitespace so the inbox row stays scannable", async () => {
    const { services, taskCreate } = buildServices();
    await tool(services).handler({
      ...OK_INPUT,
      goal: "extract\n\ttables   from\nthe pdf",
    });
    expect(firstArg<{ title: string }>(taskCreate, 0).title).toBe(
      "extract tables from the pdf",
    );
  });

  it("truncates past 80 chars with an ellipsis, leaving description intact", async () => {
    const { services, taskCreate } = buildServices();
    const goal = "x".repeat(200);
    await tool(services).handler({ ...OK_INPUT, goal });

    const arg = firstArg<{ title: string; description: string }>(taskCreate, 0);
    expect(arg.title).toHaveLength(78); // 77 chars + the single-char ellipsis
    expect(arg.title.endsWith("…")).toBe(true);
    expect(arg.description).toBe(goal); // full goal survives on the task
  });

  it("leaves an exactly-80-char goal untouched", async () => {
    const { services, taskCreate } = buildServices();
    const goal = "y".repeat(80);
    await tool(services).handler({ ...OK_INPUT, goal });
    expect(firstArg<{ title: string }>(taskCreate, 0).title).toBe(goal);
  });
});

// ── Input validation ─────────────────────────────────────────────────────

describe("use_repo input validation", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["non-string", 42],
  ])("rejects a %s goal", async (_label, goal) => {
    const { services, findById } = buildServices();
    const res = await tool(services).handler({ ...OK_INPUT, goal });
    expect(res).toEqual({
      content: {
        error: "invalid_goal",
        message: "goal must be a non-empty string",
      },
      isError: true,
    });
    // Validation is cheap and happens first — no agent lookup on a bad goal.
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    ["http (not https)", "http://github.com/o/r"],
    ["a non-GitHub host", "https://gitlab.com/o/r"],
    ["a lookalike host", "https://github.com.evil.test/o/r"],
    ["an unparseable url", "not-a-url"],
    ["a bare path", "/o/r"],
    ["an ssh remote", "git@github.com:o/r.git"],
    ["missing", undefined],
    ["a non-string", 7],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const { services, findById } = buildServices();
    const res = await tool(services).handler({ ...OK_INPUT, repo_url });
    expect(res).toEqual({
      content: {
        error: "invalid_repo_url",
        message: "repo_url must be a GitHub HTTPS URL",
      },
      isError: true,
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    ["apex github.com", "https://github.com/o/r"],
    ["a subdomain", "https://www.github.com/o/r"],
    ["mixed case host", "https://GitHub.COM/o/r"],
    ["a url with query + fragment", "https://github.com/o/r?tab=readme#install"],
  ])("accepts %s", async (_label, repo_url) => {
    const { services } = buildServices();
    const res = await tool(services).handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBeUndefined();
  });
});

// ── Limit parsing + clamping ─────────────────────────────────────────────

describe("limits", () => {
  async function limitsFor(limits: unknown) {
    const { services } = buildServices();
    const res = await tool(services).handler({ ...OK_INPUT, limits });
    return res.content.limits;
  }

  it("passes sane values through", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 1024,
      }),
    ).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 1024,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    // The ceilings are the real protection here — an agent asking for a
    // 10-hour run with 100GB of disk gets the capped values, not a refusal.
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

  it("floors fractional attempt and disk values", async () => {
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 100,
    });
  });

  it("drops non-positive and non-numeric values", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "2048",
      }),
    ).toEqual({});
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "lots"],
  ])("returns {} when limits is %s", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });

  it("keeps the recognized keys and ignores unknown ones", async () => {
    expect(await limitsFor({ disk_mb: 64, gpu_count: 8 })).toEqual({ disk_mb: 64 });
  });
});

// ── Failure envelopes ────────────────────────────────────────────────────

describe("use_repo failure paths", () => {
  it("reports agent_not_found and creates nothing", async () => {
    const { services, calls } = buildServices({
      findById: vi.fn(async () => undefined) as unknown as AgentRepository["findById"],
    });
    const res = await tool(services).handler(OK_INPUT);
    expect(res).toEqual({
      content: { error: "agent_not_found", message: "calling agent not found" },
      isError: true,
    });
    expect(calls).toEqual([]);
  });

  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { services, calls } = buildServices({
      dispatchTask: vi.fn(async () => {
        throw new Error("no daemon online");
      }) as unknown as DispatchService["dispatchTask"],
    });
    const res = await tool(services).handler(OK_INPUT);
    expect(res).toEqual({
      content: { error: "dispatch_failed", message: "no daemon online" },
      isError: true,
    });
    // No session row means a repo_run insert would violate the FK.
    expect(calls).toEqual(["task.create"]);
  });

  it("surfaces repo_run_create_failed rather than letting the agent wait on an orphan session", async () => {
    const { services } = buildServices({
      repoRunCreate: vi.fn(async () => {
        throw new Error("duplicate key");
      }) as unknown as RepoRunRepository["create"],
    });
    const res = await tool(services).handler(OK_INPUT);
    expect(res).toEqual({
      content: { error: "repo_run_create_failed", message: "duplicate key" },
      isError: true,
    });
  });

  it.each([
    ["dispatch_failed", "dispatchTask"],
    ["repo_run_create_failed", "repoRunCreate"],
  ])("stringifies a non-Error throw behind %s", async (code, which) => {
    const thrower = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { nope: true };
    });
    const { services } = buildServices(
      which === "dispatchTask"
        ? { dispatchTask: thrower as unknown as DispatchService["dispatchTask"] }
        : { repoRunCreate: thrower as unknown as RepoRunRepository["create"] },
    );
    const res = await tool(services).handler(OK_INPUT);
    expect(res.content.error).toBe(code);
    expect(typeof res.content.message).toBe("string");
  });

  it("lets a container-task insert failure propagate", async () => {
    // Unlike dispatch and repo_run, task.create has no catch — there is
    // nothing to clean up yet, so the throw reaches the MCP layer.
    const { services } = buildServices({
      taskCreate: vi.fn(async () => {
        throw new Error("task table down");
      }) as unknown as TaskRepository["create"],
    });
    await expect(tool(services).handler(OK_INPUT)).rejects.toThrow("task table down");
  });
});
