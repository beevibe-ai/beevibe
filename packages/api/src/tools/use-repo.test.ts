/**
 * use_repo tool — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler is a closure over (ctx, services), so the fakes here can
 * exercise every branch: input validation, the GitHub-URL guard, the
 * limits clamp, the container-task → dispatch → repo_run ordering, and
 * both failure paths (dispatch throws / repo_run insert throws).
 *
 * Ordering matters and is asserted explicitly: `repo_run.session_id` has
 * an FK to `session.id`, so the dispatch (which creates the session row
 * under our pre-minted id) has to land before the repo_run insert.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  RepoRun,
  RepoRunRepository,
  Task,
  TaskRepository,
  AgentRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";
import type { AgentToolResult } from "./types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_caller",
    name: "Caller",
    owner_id: "person_1",
    hierarchy_level: "team",
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
    status: "pending",
    priority: "medium",
    creator_id: "agent_caller",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Task;
}

function buildServices(
  overrides: {
    agentRepo?: Partial<AgentRepository>;
    taskRepo?: Partial<TaskRepository>;
    repoRunRepo?: Partial<RepoRunRepository>;
    dispatchService?: Partial<DispatchService>;
  } = {},
) {
  // Shared call log — lets a test assert the *relative* order of writes
  // across repos, which is the FK-safety invariant this tool maintains.
  const calls: string[] = [];

  const agentRepo = {
    findById: vi.fn(async () => fakeAgent()),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: { id: string; title: string }) => {
      calls.push("task.create");
      return fakeTask(input as Partial<Task>);
    }),
    ...overrides.taskRepo,
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: { id: string }) => {
      calls.push("repoRun.create");
      return { ...input, status: "pending" } as unknown as RepoRun;
    }),
    ...overrides.repoRunRepo,
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      calls.push("dispatch");
      return { session: { id: "sess_x" }, runtime_id: null };
    }),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  return {
    calls,
    services: {
      agentRepo,
      taskRepo,
      repoRunRepo,
      dispatchService,
    } as unknown as UseRepoServices,
  };
}

function call(
  input: Record<string, unknown>,
  services: UseRepoServices,
  agentId = "agent_caller",
): Promise<AgentToolResult> {
  return createUseRepoTool({ agentId }, services).handler(input);
}

const OK_INPUT = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/jsvine/pdfplumber",
};

// ── Tool surface ─────────────────────────────────────────────────────────

describe("createUseRepoTool — surface", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { services } = buildServices();
    const tool = createUseRepoTool({ agentId: "agent_caller" }, services);
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

// ── Input validation ─────────────────────────────────────────────────────

describe("use_repo — goal validation", () => {
  it.each([
    ["missing", { repo_url: OK_INPUT.repo_url }],
    ["empty string", { ...OK_INPUT, goal: "" }],
    ["whitespace only", { ...OK_INPUT, goal: "   " }],
    ["non-string", { ...OK_INPUT, goal: 42 }],
  ])("rejects a %s goal before touching any repo", async (_label, input) => {
    const { services } = buildServices();
    const res = await call(input, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    // Nothing should have been written — validation is the first gate.
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo — repo_url validation", () => {
  it.each([
    ["empty", ""],
    // Non-HTTPS is refused even on the right host: the sandbox clones
    // over HTTPS and we don't want to invite git:// or http://.
    ["http (not https)", "http://github.com/foo/bar"],
    ["git protocol", "git://github.com/foo/bar"],
    ["a non-GitHub host", "https://gitlab.com/foo/bar"],
    // Substring/suffix confusion — `notgithub.com` must not pass the
    // host check, and neither should github.com in a path or userinfo.
    ["a lookalike host", "https://notgithub.com/foo/bar"],
    ["github.com in the path only", "https://evil.com/github.com/foo"],
    ["unparseable", "not a url at all"],
  ])("rejects %s", async (_label, repo_url) => {
    const { services } = buildServices();
    const res = await call({ ...OK_INPUT, repo_url }, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a missing repo_url", async () => {
    const { services } = buildServices();
    const res = await call({ goal: OK_INPUT.goal }, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
  });

  it.each([
    "https://github.com/jsvine/pdfplumber",
    "https://www.github.com/jsvine/pdfplumber",
    "https://GitHub.com/jsvine/pdfplumber",
  ])("accepts %s", async (repo_url) => {
    const { services } = buildServices();
    const res = await call({ ...OK_INPUT, repo_url }, services);
    expect(res.isError).toBeUndefined();
  });

  it("trims surrounding whitespace before validating", async () => {
    const { services } = buildServices();
    const res = await call(
      { goal: "  do a thing  ", repo_url: "  https://github.com/a/b  " },
      services,
    );
    expect(res.isError).toBeUndefined();
    expect(services.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "do a thing",
        repo_url: "https://github.com/a/b",
      }),
    );
  });
});

describe("use_repo — unknown caller", () => {
  it("returns agent_not_found and creates no task", async () => {
    const { services } = buildServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const res = await call(OK_INPUT, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("use_repo — happy path", () => {
  it("returns the row ids, pending status, and a watch url", async () => {
    const { services } = buildServices();
    const res = await call(OK_INPUT, services);

    expect(res.isError).toBeUndefined();
    expect(res.content.status).toBe("pending");
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toMatch(/^task_/);
    expect(res.content.watch_url).toBe(
      `/capabilities/runs/${String(res.content.repo_run_id)}`,
    );
    expect(res.content.note).toContain("Sandbox run started");
  });

  it("creates the session row before the repo_run that FKs to it", async () => {
    const { services, calls } = buildServices();
    await call(OK_INPUT, services);
    // The container task has to exist first (work_product needs a
    // task_id), then dispatch mints the session, then repo_run.
    expect(calls).toEqual(["task.create", "dispatch", "repoRun.create"]);
  });

  it("pins the container task's creator and assignee to the calling agent", async () => {
    const { services } = buildServices();
    await call(OK_INPUT, services);
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: "agent_caller",
        creator_id: "agent_caller",
        creator_type: "agent",
        priority: "medium",
        description: OK_INPUT.goal,
      }),
    );
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const { services } = buildServices();
    const res = await call(OK_INPUT, services);
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_caller",
        type: "run_repo",
        intent: OK_INPUT.goal,
        reason: { kind: "fresh" },
        sessionIdOverride: res.content.session_id,
      }),
    );
  });

  it("writes the repo_run joined to that same session and task", async () => {
    const { services } = buildServices();
    const res = await call(OK_INPUT, services);
    expect(services.repoRunRepo.create).toHaveBeenCalledWith({
      id: res.content.repo_run_id,
      session_id: res.content.session_id,
      task_id: res.content.task_id,
      agent_id: "agent_caller",
      goal: OK_INPUT.goal,
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("echoes input_url / input_filename back when supplied", async () => {
    const { services } = buildServices();
    const res = await call(
      {
        ...OK_INPUT,
        input_url: "  https://example.com/doc.pdf  ",
        input_filename: "  doc.pdf  ",
      },
      services,
    );
    expect(res.content.input_url).toBe("https://example.com/doc.pdf");
    expect(res.content.input_filename).toBe("doc.pdf");
  });

  it("leaves input_url / input_filename undefined when absent or non-string", async () => {
    const { services } = buildServices();
    const res = await call({ ...OK_INPUT, input_url: 7 }, services);
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

// ── Container task title ─────────────────────────────────────────────────

describe("use_repo — container task title", () => {
  it("collapses runs of whitespace so the inbox row is scannable", async () => {
    const { services } = buildServices();
    await call({ ...OK_INPUT, goal: "do\n\n  this   thing" }, services);
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "do this thing" }),
    );
  });

  it("keeps an 80-char title intact", async () => {
    const { services } = buildServices();
    const goal = "x".repeat(80);
    await call({ ...OK_INPUT, goal }, services);
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: goal }),
    );
  });

  it("truncates past 80 chars to 77 plus an ellipsis", async () => {
    const { services } = buildServices();
    const goal = "y".repeat(200);
    await call({ ...OK_INPUT, goal }, services);
    const created = vi.mocked(services.taskRepo.create).mock.calls[0]?.[0];
    expect(created?.title).toBe("y".repeat(77) + "…");
    expect(created?.title).toHaveLength(78);
    // The untruncated goal still rides along as the description.
    expect(created?.description).toBe(goal);
  });
});

// ── Limits clamping ──────────────────────────────────────────────────────

describe("use_repo — limits", () => {
  async function limitsFor(limits: unknown): Promise<Record<string, unknown>> {
    const { services } = buildServices();
    const res = await call({ ...OK_INPUT, limits }, services);
    return res.content.limits as Record<string, unknown>;
  }

  it("returns an empty object when limits is absent", async () => {
    expect(await limitsFor(undefined)).toEqual({});
  });

  it.each([
    ["null", null],
    ["a string", "20"],
    ["a number", 20],
  ])("ignores limits passed as %s", async (_label, raw) => {
    expect(await limitsFor(raw)).toEqual({});
  });

  it("passes through in-range values untouched", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 15,
        max_install_attempts: 3,
        disk_mb: 2048,
      }),
    ).toEqual({
      wall_clock_minutes: 15,
      max_install_attempts: 3,
      disk_mb: 2048,
    });
  });

  it("clamps each limit to its ceiling", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 9_999,
        max_install_attempts: 50,
        disk_mb: 1_000_000,
      }),
    ).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk values", async () => {
    expect(
      await limitsFor({ max_install_attempts: 2.9, disk_mb: 100.7 }),
    ).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it("drops non-positive and non-numeric entries", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "big",
      }),
    ).toEqual({});
  });
});

// ── Failure paths ────────────────────────────────────────────────────────

describe("use_repo — dispatch failure", () => {
  it("surfaces dispatch_failed and never inserts the repo_run", async () => {
    const { services } = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime online");
        }),
      },
    });
    const res = await call(OK_INPUT, services);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("dispatch_failed");
    expect(res.content.message).toBe("no runtime online");
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error throw", async () => {
    const { services } = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "offline";
        }),
      },
    });
    const res = await call(OK_INPUT, services);
    expect(res.content).toMatchObject({
      error: "dispatch_failed",
      message: "offline",
    });
  });
});

describe("use_repo — repo_run insert failure", () => {
  it("surfaces repo_run_create_failed rather than silently stranding the agent", async () => {
    const { services } = buildServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      },
    });
    const res = await call(OK_INPUT, services);
    expect(res.isError).toBe(true);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    // The session was already dispatched — that orphan self-recovers
    // when composeDispatchPayload finds no repo_run, but the agent must
    // be told rather than left polling a run that will never start.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledOnce();
  });

  it("stringifies a non-Error throw", async () => {
    const { services } = buildServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw "nope";
        }),
      },
    });
    const res = await call(OK_INPUT, services);
    expect(res.content).toMatchObject({
      error: "repo_run_create_failed",
      message: "nope",
    });
  });
});
