/**
 * use_repo — unit tests with vitest fakes (no DB, no Docker).
 *
 * The tool itself does no sandboxing; it validates the agent's input,
 * creates the container task, and hands off to DispatchService. The
 * parts worth pinning are therefore the input gates (goal, repo_url),
 * the limit clamping (an agent asking for a 10-hour run must not get
 * one), and the two-step write ordering — repo_run.session_id has an FK
 * to session.id, so dispatch has to land *before* the repo_run insert,
 * and each step has its own failure envelope.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRun,
  RepoRunRepository,
  Session,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

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
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "Extract the tables",
    status: "in_progress",
    priority: "medium",
    creator_id: "agent_a",
    creator_type: "agent",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
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
    findById: vi.fn(async () => fakeAgent()),
    ...overrides.agentRepo,
  } as unknown as AgentRepository;

  const taskRepo = {
    create: vi.fn(async (input: Parameters<TaskRepository["create"]>[0]) =>
      fakeTask(input as Partial<Task>),
    ),
    ...overrides.taskRepo,
  } as unknown as TaskRepository;

  const repoRunRepo = {
    create: vi.fn(async (input: Parameters<RepoRunRepository["create"]>[0]) => ({
      ...input,
      transcript: [],
      started_at: new Date("2026-04-01"),
    } as RepoRun)),
    ...overrides.repoRunRepo,
  } as unknown as RepoRunRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async (input: { agentId: string; sessionIdOverride?: string }) => ({
      session: {
        id: input.sessionIdOverride ?? "sess_test",
        agent_id: input.agentId,
        type: "run_repo",
        status: "pending",
        intent: "x",
        created_at: new Date("2026-04-01"),
      } as Session,
      runtime_id: null,
    })),
    ...overrides.dispatchService,
  } as unknown as DispatchService;

  const services = {
    agentRepo,
    taskRepo,
    repoRunRepo,
    dispatchService,
  } as unknown as UseRepoServices;

  return { services, agentRepo, taskRepo, repoRunRepo, dispatchService };
}

function useRepo(services: UseRepoServices) {
  return createUseRepoTool({ agentId: "agent_a" }, services);
}

const GOOD = {
  goal: "Extract the tables from this PDF as JSON",
  repo_url: "https://github.com/acme/pdf-tables",
};

// ── Tool surface ─────────────────────────────────────────────────────────

describe("createUseRepoTool", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const { services } = buildServices();
    const t = useRepo(services);
    expect(t.name).toBe("use_repo");
    expect((t.schema as { required: string[] }).required).toEqual([
      "goal",
      "repo_url",
    ]);
  });
});

// ── Input gates ──────────────────────────────────────────────────────────

describe("input validation", () => {
  it("rejects a goal that is missing, blank, or not a string", async () => {
    const { services, agentRepo } = buildServices();
    const t = useRepo(services);

    for (const goal of [undefined, "", "   ", 7]) {
      const res = await t.handler({ ...GOOD, goal } as Record<string, unknown>);
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "invalid_goal",
        message: "goal must be a non-empty string",
      });
    }
    // Rejected before any lookup — no agent round-trip on bad input.
    expect(agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects a repo_url that is not an https github.com URL", async () => {
    const { services } = buildServices();
    const t = useRepo(services);

    const bad = [
      undefined,
      "",
      "not a url",
      "http://github.com/acme/x", // plaintext http
      "https://gitlab.com/acme/x", // wrong host
      "https://notgithub.com/acme/x", // suffix lookalike
      "https://github.com.evil.test/acme/x", // prefix lookalike
      "git@github.com:acme/x.git", // ssh
    ];
    for (const repo_url of bad) {
      const res = await t.handler({ ...GOOD, repo_url } as Record<string, unknown>);
      expect(res.isError).toBe(true);
      expect(res.content).toEqual({
        error: "invalid_repo_url",
        message: "repo_url must be a GitHub HTTPS URL",
      });
    }
  });

  it("accepts github.com and its subdomains, case-insensitively", async () => {
    const { services } = buildServices();
    const t = useRepo(services);

    for (const repo_url of [
      "https://github.com/acme/x",
      "https://www.github.com/acme/x",
      "https://GitHub.COM/acme/x",
    ]) {
      const res = await t.handler({ ...GOOD, repo_url });
      expect(res.isError).toBeUndefined();
    }
  });

  it("reports agent_not_found when the caller does not resolve", async () => {
    const { services, taskRepo } = buildServices({
      agentRepo: { findById: vi.fn(async () => undefined) },
    });
    const res = await useRepo(services).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "agent_not_found",
      message: "calling agent not found",
    });
    expect(taskRepo.create).not.toHaveBeenCalled();
  });
});

// ── Happy path ───────────────────────────────────────────────────────────

describe("happy path", () => {
  it("creates the container task, dispatches, then inserts the repo_run", async () => {
    const { services, taskRepo, repoRunRepo, dispatchService } = buildServices();
    const res = await useRepo(services).handler({
      ...GOOD,
      input_url: "  https://example.test/in.pdf  ",
      input_filename: "  in.pdf  ",
    });

    expect(res.isError).toBeUndefined();
    const content = res.content as Record<string, unknown>;
    expect(content.status).toBe("pending");
    expect(content.watch_url).toBe(`/capabilities/runs/${String(content.repo_run_id)}`);
    // input_url / input_filename are trimmed and echoed back to the agent.
    expect(content.input_url).toBe("https://example.test/in.pdf");
    expect(content.input_filename).toBe("in.pdf");

    // The container task is owned by the calling agent on both sides.
    const taskArg = vi.mocked(taskRepo.create).mock.calls[0]![0];
    expect(taskArg).toMatchObject({
      title: GOOD.goal,
      description: GOOD.goal,
      priority: "medium",
      assignee_id: "agent_a",
      creator_id: "agent_a",
      creator_type: "agent",
    });

    // Dispatch carries the run_repo type and the pre-minted session id.
    const dispatchArg = vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0];
    expect(dispatchArg).toMatchObject({
      agentId: "agent_a",
      type: "run_repo",
      intent: GOOD.goal,
      reason: { kind: "fresh" },
    });
    expect(dispatchArg.sessionIdOverride).toBe(content.session_id);
    expect(dispatchArg.task).toMatchObject({ id: content.task_id });

    // The repo_run row ties the pre-minted session + task together.
    const runArg = vi.mocked(repoRunRepo.create).mock.calls[0]![0];
    expect(runArg).toMatchObject({
      id: content.repo_run_id,
      session_id: content.session_id,
      task_id: content.task_id,
      agent_id: "agent_a",
      goal: GOOD.goal,
      repo_url: GOOD.repo_url,
      status: "pending",
    });
  });

  it("dispatches before inserting the repo_run (FK on session_id)", async () => {
    const order: string[] = [];
    const { services } = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          order.push("dispatch");
          return { session: {} as Session, runtime_id: null };
        }),
      },
      repoRunRepo: {
        create: vi.fn(async (input) => {
          order.push("repo_run");
          return input as RepoRun;
        }),
      },
    });
    await useRepo(services).handler(GOOD);
    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("trims the goal and uses it verbatim for intent and description", async () => {
    const { services, taskRepo, dispatchService } = buildServices();
    await useRepo(services).handler({ ...GOOD, goal: "  tidy up  " });
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0]).toMatchObject({
      title: "tidy up",
      description: "tidy up",
    });
    expect(vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0].intent).toBe(
      "tidy up",
    );
  });

  it("omits input_url / input_filename when not supplied", async () => {
    const { services } = buildServices();
    const res = await useRepo(services).handler(GOOD);
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

// ── Container task title ─────────────────────────────────────────────────

describe("container task title", () => {
  it("collapses whitespace so the inbox row stays scannable", async () => {
    const { services, taskRepo } = buildServices();
    await useRepo(services).handler({
      ...GOOD,
      goal: "extract\n\ttables   from  this PDF",
    });
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0].title).toBe(
      "extract tables from this PDF",
    );
  });

  it("truncates past 80 chars to 77 + an ellipsis, leaving description whole", async () => {
    const { services, taskRepo } = buildServices();
    const goal = "x".repeat(200);
    await useRepo(services).handler({ ...GOOD, goal });

    const arg = vi.mocked(taskRepo.create).mock.calls[0]![0];
    expect(arg.title).toBe("x".repeat(77) + "…");
    expect(arg.title).toHaveLength(78);
    // The full goal still reaches the child agent via the description.
    expect(arg.description).toBe(goal);
  });

  it("keeps an exactly-80-char title untouched", async () => {
    const { services, taskRepo } = buildServices();
    const goal = "y".repeat(80);
    await useRepo(services).handler({ ...GOOD, goal });
    expect(vi.mocked(taskRepo.create).mock.calls[0]![0].title).toBe(goal);
  });
});

// ── Limit clamping ───────────────────────────────────────────────────────

describe("limit clamping", () => {
  async function limitsFor(limits: unknown) {
    const { services } = buildServices();
    const res = await useRepo(services).handler({ ...GOOD, limits } as Record<
      string,
      unknown
    >);
    return res.content.limits;
  }

  it("passes sane limits through unchanged", async () => {
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

  it("caps each limit at its ceiling", async () => {
    // An agent cannot talk itself into a 10-hour run or a 500GB disk.
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

  it("floors the integer limits but leaves wall clock fractional", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 2.5,
        max_install_attempts: 3.9,
        disk_mb: 512.7,
      }),
    ).toEqual({
      wall_clock_minutes: 2.5,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("drops non-positive and non-numeric values rather than clamping them", async () => {
    expect(
      await limitsFor({
        wall_clock_minutes: 0,
        max_install_attempts: -1,
        disk_mb: "1024",
      }),
    ).toEqual({});
  });

  it("treats a missing or non-object limits as no limits", async () => {
    for (const raw of [undefined, null, "20", 20]) {
      expect(await limitsFor(raw)).toEqual({});
    }
  });

  it("keeps the limits it understands and ignores the rest", async () => {
    expect(await limitsFor({ disk_mb: 256, nonsense: true })).toEqual({
      disk_mb: 256,
    });
  });
});

// ── Write failures ───────────────────────────────────────────────────────

describe("write failures", () => {
  it("reports dispatch_failed and skips the repo_run insert", async () => {
    const { services, repoRunRepo } = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no daemon online");
        }),
      },
    });
    const res = await useRepo(services).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "dispatch_failed",
      message: "no daemon online",
    });
    expect(repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("reports repo_run_create_failed when the row lands after dispatch", async () => {
    const { services } = buildServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      },
    });
    const res = await useRepo(services).handler(GOOD);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "duplicate key",
    });
  });

  it("stringifies a non-Error throw on either write", async () => {
    const dispatchFail = buildServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "nope";
        }),
      },
    });
    expect(
      (await useRepo(dispatchFail.services).handler(GOOD)).content,
    ).toEqual({ error: "dispatch_failed", message: "nope" });

    const runFail = buildServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw "nope";
        }),
      },
    });
    expect((await useRepo(runFail.services).handler(GOOD)).content).toEqual({
      error: "repo_run_create_failed",
      message: "nope",
    });
  });
});
