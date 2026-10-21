/**
 * use_repo — unit tests with vitest fakes (no DB, no Docker).
 *
 * The handler's job is validation + a three-write sequence (container
 * task → dispatch → repo_run) whose *order* is load-bearing:
 * repo_run.session_id has an FK to session.id, so the session has to
 * exist first. These tests pin the order and both half-failed states,
 * because the recovery path for each is different.
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
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT_ID = "agent_caller";
const OWNER_ID = "person_owner";
const GOAL = "Extract the tables from this PDF as JSON";
const REPO_URL = "https://github.com/jsvine/pdfplumber";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Caller",
    owner_id: OWNER_ID,
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
    title: GOAL,
    status: "assigned",
    priority: "medium",
    creator_id: AGENT_ID,
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeRepoRun(overrides: Partial<RepoRun> = {}): RepoRun {
  return {
    id: "repo_1",
    agent_id: AGENT_ID,
    goal: GOAL,
    repo_url: REPO_URL,
    status: "pending",
    transcript: [],
    started_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function buildServices(
  overrides: {
    agentRepo?: Partial<AgentRepository>;
    taskRepo?: Partial<TaskRepository>;
    repoRunRepo?: Partial<RepoRunRepository>;
    dispatchService?: Partial<DispatchService>;
  } = {},
) {
  const agentRepo = {
    findById: vi.fn(async (id: string) =>
      id === AGENT_ID ? fakeAgent() : undefined,
    ),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) =>
      fakeTask(input as Partial<Task>),
    ),
    ...overrides.taskRepo,
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Parameters<RepoRunRepository["create"]>[0]) =>
      fakeRepoRun(input as Partial<RepoRun>),
    ),
    ...overrides.repoRunRepo,
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async () => ({ session: {}, runtime_id: null })),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  return { agentRepo, taskRepo, repoRunRepo, dispatchService };
}

function build(services: UseRepoServices, agentId = AGENT_ID) {
  return createUseRepoTool({ agentId }, services);
}

describe("use_repo — input validation", () => {
  it("rejects a missing goal before touching any repo", async () => {
    const services = buildServices();
    const res = await build(services).handler({ repo_url: REPO_URL });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only goal", async () => {
    const res = await build(buildServices()).handler({
      goal: "   \n ",
      repo_url: REPO_URL,
    });
    expect(res.content.error).toBe("invalid_goal");
  });

  it("rejects a non-string goal", async () => {
    const res = await build(buildServices()).handler({
      goal: 42,
      repo_url: REPO_URL,
    });
    expect(res.content.error).toBe("invalid_goal");
  });

  // The URL is handed to a sandbox that clones it, so the host check is
  // the only thing standing between the agent and an arbitrary clone
  // target. Each of these has to be refused.
  it.each([
    ["missing", undefined],
    ["plain http", "http://github.com/owner/repo"],
    ["a non-GitHub host", "https://gitlab.com/owner/repo"],
    ["a lookalike host", "https://github.com.evil.test/owner/repo"],
    ["an ssh ref", "git@github.com:owner/repo.git"],
    ["unparseable text", "not a url at all"],
  ])("rejects repo_url that is %s", async (_label, repoUrl) => {
    const services = buildServices();
    const res = await build(services).handler({ goal: GOAL, repo_url: repoUrl });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("accepts a github.com subdomain URL", async () => {
    const res = await build(buildServices()).handler({
      goal: GOAL,
      repo_url: "https://www.github.com/owner/repo",
    });
    expect(res.isError).toBeUndefined();
  });

  it("errors when the calling agent no longer exists", async () => {
    const services = buildServices();
    const res = await build(services, "agent_ghost").handler({
      goal: GOAL,
      repo_url: REPO_URL,
    });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo — happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const order: string[] = [];
    const services = buildServices({
      taskRepo: {
        create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) => {
          order.push("task");
          return fakeTask(input as Partial<Task>);
        }),
      },
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          order.push("dispatch");
          return { session: {}, runtime_id: null } as never;
        }),
      },
      repoRunRepo: {
        create: vi.fn(async (input: Parameters<RepoRunRepository["create"]>[0]) => {
          order.push("repo_run");
          return fakeRepoRun(input as Partial<RepoRun>);
        }),
      },
    });

    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });

    expect(res.isError).toBeUndefined();
    // repo_run.session_id FKs to session.id, so dispatch (which inserts
    // the session) must land before the repo_run write.
    expect(order).toEqual(["task", "dispatch", "repo_run"]);
  });

  it("returns the ids, pending status and a watch URL for the run", async () => {
    const services = buildServices();
    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });

    const content = res.content as Record<string, string>;
    expect(content.status).toBe("pending");
    expect(content.repo_run_id).toMatch(/^repo_/);
    expect(content.session_id).toMatch(/^sess_/);
    expect(content.task_id).toEqual(expect.any(String));
    expect(content.watch_url).toBe(`/capabilities/runs/${content.repo_run_id}`);
  });

  it("pins the container task to the caller and titles it from the goal", async () => {
    const services = buildServices();
    await build(services).handler({ goal: `  ${GOAL}  `, repo_url: REPO_URL });

    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: GOAL,
        description: GOAL,
        priority: "medium",
        assignee_id: AGENT_ID,
        creator_id: AGENT_ID,
        creator_type: "agent",
      }),
    );
  });

  it("collapses whitespace and ellipsises a title over 80 chars", async () => {
    const services = buildServices();
    const longGoal = `Extract\n   every  table from ${"x".repeat(80)}`;
    await build(services).handler({ goal: longGoal, repo_url: REPO_URL });

    const created = (services.taskRepo.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { title: string; description: string };
    expect(created.title).toHaveLength(78); // 77 chars + the ellipsis
    expect(created.title.endsWith("…")).toBe(true);
    expect(created.title).not.toContain("\n");
    // description keeps the untruncated goal — only the inbox row is cut.
    expect(created.description).toBe(longGoal);
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const services = buildServices();
    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });

    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        type: "run_repo",
        intent: GOAL,
        reason: { kind: "fresh" },
        sessionIdOverride: (res.content as { session_id: string }).session_id,
      }),
    );
  });

  it("writes the repo_run row with the same session + task ids it returns", async () => {
    const services = buildServices();
    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });
    const content = res.content as Record<string, string>;

    expect(services.repoRunRepo.create).toHaveBeenCalledWith({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: AGENT_ID,
      goal: GOAL,
      repo_url: REPO_URL,
      status: "pending",
    });
  });

  it("trims the repo_url before persisting it", async () => {
    const services = buildServices();
    await build(services).handler({ goal: GOAL, repo_url: `  ${REPO_URL}  ` });

    expect(services.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ repo_url: REPO_URL }),
    );
  });
});

describe("use_repo — optional input passthrough", () => {
  it("echoes a trimmed input_url and input_filename", async () => {
    const res = await build(buildServices()).handler({
      goal: GOAL,
      repo_url: REPO_URL,
      input_url: "  https://example.test/a.pdf  ",
      input_filename: "  a.pdf  ",
    });

    expect(res.content.input_url).toBe("https://example.test/a.pdf");
    expect(res.content.input_filename).toBe("a.pdf");
  });

  it("leaves both undefined when not supplied, and ignores non-strings", async () => {
    const res = await build(buildServices()).handler({
      goal: GOAL,
      repo_url: REPO_URL,
      input_url: 7,
    });

    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo — limit parsing", () => {
  async function limitsFor(raw: unknown): Promise<Record<string, number>> {
    const res = await build(buildServices()).handler({
      goal: GOAL,
      repo_url: REPO_URL,
      limits: raw,
    });
    return res.content.limits as Record<string, number>;
  }

  it("passes sane limits through unchanged", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 }),
    ).toEqual({ wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 });
  });

  // The ceilings are the whole point: an agent asking for a 10-hour,
  // 100GB run gets clamped, not refused.
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
    expect(await limitsFor({ max_install_attempts: 2.9, disk_mb: 512.7 })).toEqual({
      max_install_attempts: 2,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric values instead of defaulting them", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "lots",
      }),
    ).toEqual({});
  });

  it("returns an empty object when limits is absent or not an object", async () => {
    expect(await limitsFor(undefined)).toEqual({});
    expect(await limitsFor("20m")).toEqual({});
    expect(await limitsFor(null)).toEqual({});
  });
});

describe("use_repo — partial failure", () => {
  it("reports dispatch_failed and never writes a repo_run", async () => {
    const services = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime online");
        }),
      },
    });

    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no runtime online",
    });
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  // Orphan session: composeDispatchPayload self-recovers by marking the
  // session failed, but the agent has to be told so it doesn't sit
  // waiting on a transcript that will never come.
  it("reports repo_run_create_failed when the session landed but the run row didn't", async () => {
    const services = buildServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      },
    });

    const res = await build(services).handler({ goal: GOAL, repo_url: REPO_URL });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error throw from either write", async () => {
    const dispatchRes = await build(
      buildServices({
        dispatchService: { dispatchTask: vi.fn(async () => Promise.reject("boom")) },
      }),
    ).handler({ goal: GOAL, repo_url: REPO_URL });
    expect(dispatchRes.content.message).toBe("boom");

    const runRes = await build(
      buildServices({
        repoRunRepo: { create: vi.fn(async () => Promise.reject("splat")) },
      }),
    ).handler({ goal: GOAL, repo_url: REPO_URL });
    expect(runRes.content.message).toBe("splat");
  });
});

describe("use_repo — tool surface", () => {
  it("declares goal + repo_url as the only required inputs", () => {
    const tool = build(buildServices());
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
    expect(tool.schema.additionalProperties).toBe(false);
  });
});
