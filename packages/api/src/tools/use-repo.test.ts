/**
 * use_repo tool — vitest fakes, no DB and no Docker.
 *
 * Three things here are worth pinning down. First, `repo_url` is a
 * trust boundary: this tool hands the URL to a sandbox that clones and
 * executes it, so the GitHub-host check has to reject look-alikes
 * (`evilgithub.com`, `github.com.evil.com`) and plain http, not just
 * obvious junk. Second, `limits` are clamped server-side — an agent
 * asking for a 10-hour run or a 500 GB disk must come back capped, not
 * honored. Third, the write order (task → session → repo_run) is load-
 * bearing because `repo_run.session_id` carries an FK, and each of the
 * two failure points has its own error code so the agent can tell a
 * retryable dispatch failure from an orphaned session.
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

const AGENT = "agent_a";
const GOAL = "Extract the tables from this PDF as JSON";
const REPO = "https://github.com/jsvine/pdfplumber";

function makeServices(overrides: Partial<UseRepoServices> = {}): UseRepoServices {
  return {
    agentRepo: {
      findById: vi.fn(async (id: string) => ({ id, name: "Ada", hierarchy_level: "ic" })),
    } as unknown as AgentRepository,
    taskRepo: {
      create: vi.fn(async (input: { id: string; title: string }) => input as unknown as Task),
    } as unknown as TaskRepository,
    repoRunRepo: {
      create: vi.fn(async (input: unknown) => input),
    } as unknown as RepoRunRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({ session: { id: "sess_x" }, runtime_id: null })),
    } as unknown as DispatchService,
    ...overrides,
  };
}

function build(overrides: Partial<UseRepoServices> = {}) {
  const services = makeServices(overrides);
  return { tool: createUseRepoTool({ agentId: AGENT }, services), services };
}

describe("use_repo happy path", () => {
  it("creates the container task, dispatches, then records the repo run", async () => {
    const { tool, services } = build();
    const res = await tool.handler({ goal: `  ${GOAL}  `, repo_url: `  ${REPO}  ` });

    expect(res.isError).toBeUndefined();
    expect(res.content).toMatchObject({
      status: "pending",
      task_id: expect.stringMatching(/^task_/),
      session_id: expect.stringMatching(/^sess_/),
      repo_run_id: expect.stringMatching(/^repo_/),
    });
    expect(res.content.watch_url).toBe(`/capabilities/runs/${res.content.repo_run_id}`);

    // Container task is owned by the calling agent on both sides.
    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: GOAL,
        description: GOAL,
        assignee_id: AGENT,
        creator_id: AGENT,
        creator_type: "agent",
      }),
    );
    // The session id the tool reports is the one it pre-minted and
    // forced onto the dispatch, so the repo_run FK resolves.
    expect(services.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        type: "run_repo",
        intent: GOAL,
        reason: { kind: "fresh" },
        sessionIdOverride: res.content.session_id,
      }),
    );
    expect(services.repoRunRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: res.content.repo_run_id,
        session_id: res.content.session_id,
        task_id: res.content.task_id,
        agent_id: AGENT,
        goal: GOAL,
        repo_url: REPO,
        status: "pending",
      }),
    );
  });

  it("inserts the session before the repo_run (FK ordering)", async () => {
    const order: string[] = [];
    const services = makeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockImplementation(async () => {
      order.push("dispatch");
      return { session: { id: "sess_x" }, runtime_id: null } as never;
    });
    vi.mocked(services.repoRunRepo.create).mockImplementation(async (input) => {
      order.push("repo_run");
      return input as never;
    });
    const tool = createUseRepoTool({ agentId: AGENT }, services);

    await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(order).toEqual(["dispatch", "repo_run"]);
  });

  it("passes the input download through to the agent-visible result", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      input_url: "  https://example.com/report.pdf  ",
      input_filename: "  report.pdf  ",
    });

    expect(res.content).toMatchObject({
      input_url: "https://example.com/report.pdf",
      input_filename: "report.pdf",
    });
  });

  it("mints a distinct run and session per call", async () => {
    const { tool } = build();
    const a = await tool.handler({ goal: GOAL, repo_url: REPO });
    const b = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(a.content.repo_run_id).not.toBe(b.content.repo_run_id);
    expect(a.content.session_id).not.toBe(b.content.session_id);
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });

  it("truncates a long goal into a scannable task title", async () => {
    const { tool, services } = build();
    await tool.handler({ goal: "g".repeat(200), repo_url: REPO });

    const title = vi.mocked(services.taskRepo.create).mock.calls[0]![0].title as string;
    expect(title).toHaveLength(78); // 77 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in the task title but keeps the full description", async () => {
    const { tool, services } = build();
    await tool.handler({ goal: "extract\n\n  the   tables", repo_url: REPO });

    expect(services.taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "extract the tables",
        description: "extract\n\n  the   tables",
      }),
    );
  });
});

describe("use_repo input validation", () => {
  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["a non-string", 42],
  ])("rejects a %s goal", async (_label, goal) => {
    const { tool, services } = build();
    const res = await tool.handler({ ...(goal === undefined ? {} : { goal }), repo_url: REPO });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_goal");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["a look-alike host", "https://evilgithub.com/a/b"],
    ["a suffixed host", "https://github.com.evil.com/a/b"],
    ["plain http", "http://github.com/a/b"],
    ["a non-GitHub host", "https://gitlab.com/a/b"],
    ["a git+ssh remote", "git@github.com:a/b.git"],
    ["an unparseable string", "not a url"],
    ["a blank string", "   "],
    ["a non-string", 42],
  ])("rejects %s as repo_url", async (_label, repo_url) => {
    const { tool, services } = build();
    const res = await tool.handler({ goal: GOAL, repo_url });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("invalid_repo_url");
    // Nothing is written for a rejected URL.
    expect(services.taskRepo.create).not.toHaveBeenCalled();
    expect(services.dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the bare host", "https://github.com/owner/repo"],
    ["a www subdomain", "https://www.github.com/owner/repo"],
    ["an uppercased host", "https://GitHub.com/owner/repo"],
  ])("accepts %s", async (_label, repo_url) => {
    const { tool } = build();
    const res = await tool.handler({ goal: GOAL, repo_url });

    expect(res.isError).toBeUndefined();
  });
});

describe("use_repo limits", () => {
  it("passes sane limits through untouched", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { wall_clock_minutes: 10, max_install_attempts: 3, disk_mb: 512 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 10,
      max_install_attempts: 3,
      disk_mb: 512,
    });
  });

  it("clamps limits to their server-side ceilings", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { wall_clock_minutes: 600, max_install_attempts: 99, disk_mb: 500_000 },
    });

    expect(res.content.limits).toEqual({
      wall_clock_minutes: 60,
      max_install_attempts: 5,
      disk_mb: 10_000,
    });
  });

  it("floors fractional attempt and disk counts", async () => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      limits: { max_install_attempts: 2.9, disk_mb: 100.7 },
    });

    expect(res.content.limits).toEqual({ max_install_attempts: 2, disk_mb: 100 });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a non-object", "20"],
    ["an object of non-numbers", { wall_clock_minutes: "20", disk_mb: null }],
    ["zero and negative values", { wall_clock_minutes: 0, max_install_attempts: -1, disk_mb: -5 }],
  ])("drops %s limits to the defaults", async (_label, limits) => {
    const { tool } = build();
    const res = await tool.handler({
      goal: GOAL,
      repo_url: REPO,
      ...(limits === undefined ? {} : { limits }),
    });

    expect(res.content.limits).toEqual({});
  });
});

describe("use_repo failure paths", () => {
  it("reports agent_not_found without writing anything", async () => {
    const services = makeServices();
    vi.mocked(services.agentRepo.findById).mockResolvedValue(undefined);
    const tool = createUseRepoTool({ agentId: AGENT }, services);

    const res = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(res.isError).toBe(true);
    expect(res.content.error).toBe("agent_not_found");
    expect(services.taskRepo.create).not.toHaveBeenCalled();
  });

  it("reports dispatch_failed and never inserts an unreferenced repo_run", async () => {
    const services = makeServices();
    vi.mocked(services.dispatchService.dispatchTask).mockRejectedValue(
      new Error("no runtime bound"),
    );
    const tool = createUseRepoTool({ agentId: AGENT }, services);

    const res = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({ error: "dispatch_failed", message: "no runtime bound" });
    expect(services.repoRunRepo.create).not.toHaveBeenCalled();
  });

  it("surfaces repo_run_create_failed rather than letting the agent wait on an orphan", async () => {
    const services = makeServices();
    vi.mocked(services.repoRunRepo.create).mockRejectedValue(new Error("unique violation"));
    const tool = createUseRepoTool({ agentId: AGENT }, services);

    const res = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual({
      error: "repo_run_create_failed",
      message: "unique violation",
    });
  });

  it.each([
    ["dispatchService", "dispatchTask", "dispatch_failed"],
    ["repoRunRepo", "create", "repo_run_create_failed"],
  ] as const)("stringifies a non-Error thrown by %s", async (dep, method, code) => {
    const services = makeServices();
    const target = services[dep as "dispatchService" | "repoRunRepo"] as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    target[method]!.mockRejectedValue("socket hang up");
    const tool = createUseRepoTool({ agentId: AGENT }, services);

    const res = await tool.handler({ goal: GOAL, repo_url: REPO });

    expect(res.content).toEqual({ error: code, message: "socket hang up" });
  });
});
