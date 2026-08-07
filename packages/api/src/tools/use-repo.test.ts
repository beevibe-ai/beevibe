/**
 * `createUseRepoTool` — the Agent App Store's verb.
 *
 * The handler is a five-step sequence with a failure mode at each step:
 * validate the goal + repo URL, resolve the caller, create the
 * container task, dispatch the sandbox session, then insert the
 * repo_run that the daemon's payload composer looks up by session id.
 * The ordering between those last two matters (repo_run.session_id has
 * an FK to session.id), so this suite pins it alongside the validation
 * and the two partial-failure envelopes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  RepoRunRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { createUseRepoTool, type UseRepoServices } from "./use-repo.js";

const AGENT = "agent_a";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Helper",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeServices(overrides: Partial<UseRepoServices> = {}): UseRepoServices {
  return {
    agentRepo: { findById: vi.fn(async () => fakeAgent()) } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (input: Partial<Task>) => ({ ...input }) as Task),
    } as unknown as TaskRepository,
    repoRunRepo: { create: vi.fn(async () => undefined) } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({ session: { id: "sess_x" }, runtime_id: "rt_1" })),
    } as unknown as DispatchService,
    ...overrides,
  };
}

function makeTool(services: UseRepoServices = makeServices()) {
  return createUseRepoTool({ agentId: AGENT }, services);
}

const OK_INPUT = {
  goal: "extract the tables",
  repo_url: "https://github.com/acme/pdfplumber",
};

describe("use_repo tool definition", () => {
  it("is named use_repo and requires goal + repo_url", () => {
    const tool = makeTool();
    expect(tool.name).toBe("use_repo");
    expect(tool.schema.required).toEqual(["goal", "repo_url"]);
  });
});

describe("use_repo input validation", () => {
  it("rejects a missing goal before touching any port", async () => {
    const services = makeServices();
    const res = await makeTool(services).handler({ repo_url: OK_INPUT.repo_url });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(services.agentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only goal", async () => {
    const res = await makeTool().handler({ ...OK_INPUT, goal: "   " });
    expect(res.content.error).toBe("invalid_goal");
  });

  it("rejects a non-string goal", async () => {
    const res = await makeTool().handler({ ...OK_INPUT, goal: 42 });
    expect(res.content.error).toBe("invalid_goal");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 7],
    ["plain http", "http://github.com/acme/tool"],
    ["a non-GitHub host", "https://gitlab.com/acme/tool"],
    ["a lookalike host", "https://github.com.evil.dev/acme/tool"],
    ["unparseable", "not a url"],
    ["an ssh remote", "git@github.com:acme/tool.git"],
  ])("rejects %s repo_url", async (_label, repo_url) => {
    const services = makeServices();
    const res = await makeTool(services).handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "https://GitHub.com/acme/tool",
  ])("accepts %s", async (repo_url) => {
    const res = await makeTool().handler({ ...OK_INPUT, repo_url });
    expect(res.isError).toBeUndefined();
  });

  it("404s the tool call when the calling agent row is gone", async () => {
    const services = makeServices({
      agentRepo: { findById: vi.fn(async () => undefined) } as unknown as AgentRepository,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });
});

describe("use_repo happy path", () => {
  it("returns the run ids, watch url and a poll hint", async () => {
    const res = await makeTool().handler(OK_INPUT);
    expect(res.isError).toBeUndefined();
    expect(res.content.status).toBe("pending");
    expect(res.content.repo_run_id).toMatch(/^repo_/);
    expect(res.content.session_id).toMatch(/^sess_/);
    expect(res.content.task_id).toMatch(/^task_/);
    expect(res.content.watch_url).toBe(`/capabilities/runs/${res.content.repo_run_id}`);
    expect(res.content.note).toContain("poll");
  });

  it("creates the container task assigned to and created by the calling agent", async () => {
    const services = makeServices();
    await makeTool(services).handler(OK_INPUT);
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "extract the tables",
        description: "extract the tables",
        priority: "medium",
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
      }),
    );
  });

  it("collapses whitespace and truncates a long goal into the task title", async () => {
    const services = makeServices();
    const goal = "a".repeat(200);
    await makeTool(services).handler({ ...OK_INPUT, goal });
    const created = vi.mocked(services.taskRepo.create).mock.calls[0]![0] as Partial<Task>;
    expect(created.title).toHaveLength(78); // 77 chars + ellipsis
    expect(created.title!.endsWith("…")).toBe(true);
    // The untruncated goal still reaches the child agent.
    expect(created.description).toBe(goal);
  });

  it("keeps a multi-line goal on one line in the title", async () => {
    const services = makeServices();
    await makeTool(services).handler({ ...OK_INPUT, goal: "  do\n\n  this  thing  " });
    const created = vi.mocked(services.taskRepo.create).mock.calls[0]![0] as Partial<Task>;
    expect(created.title).toBe("do this thing");
  });

  it("dispatches a run_repo session under the pre-minted session id", async () => {
    const services = makeServices();
    const res = await makeTool(services).handler(OK_INPUT);
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        type: "run_repo",
        intent: "extract the tables",
        reason: { kind: "fresh" },
        sessionIdOverride: res.content.session_id,
      }),
    );
  });

  it("inserts the repo_run only after the session exists (FK ordering)", async () => {
    const order: string[] = [];
    const services = makeServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          order.push("dispatch");
          return { session: { id: "sess_x" }, runtime_id: null };
        }),
      } as unknown as DispatchService,
      repoRunRepo: {
        create: vi.fn(async () => {
          order.push("repo_run");
        }),
      } as unknown as RepoRunRepository,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(order).toEqual(["dispatch", "repo_run"]);
    expect(services.repoRunRepo.create).toHaveBeenCalledWith({
      id: res.content.repo_run_id,
      session_id: res.content.session_id,
      task_id: res.content.task_id,
      agent_id: AGENT,
      goal: "extract the tables",
      repo_url: OK_INPUT.repo_url,
      status: "pending",
    });
  });

  it("trims the goal and repo_url before persisting them", async () => {
    const services = makeServices();
    await makeTool(services).handler({
      goal: "  tidy up  ",
      repo_url: "  https://github.com/acme/tool  ",
    });
    expect(services.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "tidy up",
        repo_url: "https://github.com/acme/tool",
      }),
    );
  });

  it("echoes the optional input download fields back to the agent", async () => {
    const res = await makeTool().handler({
      ...OK_INPUT,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });
    expect(res.content.input_url).toBe("https://example.com/report.pdf");
    expect(res.content.input_filename).toBe("report.pdf");
  });

  it("leaves the input fields undefined when not supplied", async () => {
    const res = await makeTool().handler(OK_INPUT);
    expect(res.content.input_url).toBeUndefined();
    expect(res.content.input_filename).toBeUndefined();
  });
});

describe("use_repo limits parsing", () => {
  async function limitsFor(limits: unknown) {
    const res = await makeTool().handler({ ...OK_INPUT, limits });
    return res.content.limits;
  }

  it("passes sane values through, flooring the integer caps", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 5, max_install_attempts: 3.7, disk_mb: 512.9 }),
    ).toEqual({ wall_clock_minutes: 5, max_install_attempts: 3, disk_mb: 512 });
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

  it("drops zero, negative and non-numeric values rather than clamping them up", async () => {
    expect(
      await limitsFor({ wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: "512" }),
    ).toEqual({});
  });

  it("ignores unknown keys", async () => {
    expect(await limitsFor({ gpu: true, wall_clock_minutes: 10 })).toEqual({
      wall_clock_minutes: 10,
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "20m"],
    ["a number", 20],
  ])("returns {} for %s limits", async (_label, limits) => {
    expect(await limitsFor(limits)).toEqual({});
  });
});

describe("use_repo partial failures", () => {
  it("reports dispatch_failed without attempting the repo_run insert", async () => {
    const services = makeServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("no runtime available");
        }),
      } as unknown as DispatchService,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("dispatch_failed");
    expect(res.content.message).toBe("no runtime available");
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error dispatch throw", async () => {
    const services = makeServices({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw "boom";
        }),
      } as unknown as DispatchService,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(res.content.message).toBe("boom");
  });

  it("surfaces repo_run_create_failed so the agent doesn't wait on an orphan session", async () => {
    const services = makeServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw new Error("duplicate key");
        }),
      } as unknown as RepoRunRepository,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("repo_run_create_failed");
    expect(res.content.message).toBe("duplicate key");
  });

  it("stringifies a non-Error repo_run throw", async () => {
    const services = makeServices({
      repoRunRepo: {
        create: vi.fn(async () => {
          throw 500;
        }),
      } as unknown as RepoRunRepository,
    });
    const res = await makeTool(services).handler(OK_INPUT);
    expect(res.content.message).toBe("500");
  });
});
